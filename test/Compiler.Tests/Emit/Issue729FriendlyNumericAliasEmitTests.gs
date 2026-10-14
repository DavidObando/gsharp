// <copyright file="Issue729FriendlyNumericAliasEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #729 / ADR-0098 — friendly numeric type aliases (`int`,
/// `long`, `byte`, …) compile, IL-verify, and run identically
/// to their canonical width-bearing spellings (`int32`, `int64`,
/// `uint8`, …). For every alias we compile one program written in
/// aliases and one written in canonical names, then assert byte-identical
/// IL (PE body image) between them. This is the strongest possible
/// demonstration that aliases resolve in the binder and that nothing
/// alias-specific reaches the emitter.
open class Issue729FriendlyNumericAliasEmitTests {
    @Theory
    @MemberData("AliasCases")
    func Alias_AndCanonical_Compile_VerifyAndRun(
        alias string,
        canonical string,
        aliasLiteral string,
        canonicalLiteral string
    ) {
        // Each program declares a function `pair(x, y) -> x + y` with both
        // parameters typed by the alias (resp. canonical) name, sums two
        // literals of the matching type, then prints the result. Both
        // programs must produce the same observable output AND identical
        // .text PE body bytes — confirming that aliases erase to the
        // canonical type before reaching the emitter.
        let aliasSource = (`
package P
import System

func pair(x ` + "$alias" + `, y ` + "$alias" + `) ` + "$alias" + ` { return x + y }

Console.WriteLine(pair(` + "$aliasLiteral" + `, ` + "$aliasLiteral" + `))
`)
        let canonicalSource = (`
package P
import System

func pair(x ` + "$canonical" + `, y ` + "$canonical" + `) ` + "$canonical" + ` { return x + y }

Console.WriteLine(pair(` + "$canonicalLiteral" + `, ` + "$canonicalLiteral" + `))
`)
        let (aliasOutput, aliasIl) = CompileVerifyAndRun(aliasSource, "alias")
        let (canonicalOutput, canonicalIl) = CompileVerifyAndRun(canonicalSource, "canonical")
        Assert.Equal(canonicalOutput, aliasOutput)
        // Byte-identical .text body bytes confirm aliases resolve in the
        // binder to the exact same TypeSymbol that the emitter would have
        // received from the canonical name.
        Assert.Equal(canonicalIl, aliasIl)
    }

    @Fact
    func Mixed_AliasAndCanonical_Interoperate_AtRuntime() {
        // A sample that intentionally mixes aliases and canonical names
        // across function boundaries demonstrates equivalence at the call
        // site without any explicit conversion. Output is a single line so
        // the assertion is exact.
        const source = `
package P
import System

func sumCanonical(a int32, b int32) int32 { return a + b }
func sumAlias(a int, b int) int { return sumCanonical(a, b) }

let x int = sumCanonical(2, 3)
let y int32 = sumAlias(x, 4)

Console.WriteLine(y)
`
        let (output, _) = CompileVerifyAndRun(source, "mixed")
        Assert.Equal("9${Environment.NewLine}", output)
    }

    shared {
        prop AliasCases IEnumerable[[]object] -> [][]object{
            []object{"int", "int32", "42", "42"},
            []object{"uint", "uint32", "uint32(42)", "uint32(42)"},
            []object{"long", "int64", "42L", "42L"},
            []object{"ulong", "uint64", "42UL", "42UL"},
            []object{"short", "int16", "int16(42)", "int16(42)"},
            []object{"ushort", "uint16", "uint16(42)", "uint16(42)"},
            []object{"byte", "uint8", "uint8(42)", "uint8(42)"},
            []object{"sbyte", "int8", "int8(42)", "int8(42)"},
            []object{"float", "float32", "1.5F", "1.5F"},
            []object{"double", "float64", "1.5", "1.5"}
        }

        private func CompileVerifyAndRun(source string, tag string)(Output string, PeBody[]uint8) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue729_${tag}_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                // Extract method bodies (the IL inside `.text`) so we can
                // compare two alias-vs-canonical runs byte-for-byte. We hash
                // every method body because PE metadata contains tokens that
                // intentionally differ across compilations (timestamps, GUIDs,
                // assembly-name string offsets, etc.).
                let bodyBytes = ExtractAllMethodBodyBytes(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (stdout.ReplaceLineEndings(Environment.NewLine), bodyBytes)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func ExtractAllMethodBodyBytes(assemblyPath string)[]uint8 {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let md = pe.GetMetadataReader()
            // Walk every MethodDef in MetadataToken order and append its IL
            // body bytes. We deliberately ignore the body header (locals
            // signature token, max-stack flags, …) because the locals
            // signature index references the StandAloneSig table whose token
            // value is implementation-stable for these tiny programs — but if
            // it ever diverged the difference would not represent a real
            // emit-level change.
            using let ms = MemoryStream()
            for handle in md.MethodDefinitions {
                let def = md.GetMethodDefinition(handle)
                if def.RelativeVirtualAddress == 0 {
                    continue
                }
                let body = pe.GetMethodBody(def.RelativeVirtualAddress)
                let il[]?uint8 = body.GetILBytes()
                if il == nil {
                    continue
                }
                ms.Write(il, 0, il.Length)
            }
            return ms.ToArray()
        }
    }
}
