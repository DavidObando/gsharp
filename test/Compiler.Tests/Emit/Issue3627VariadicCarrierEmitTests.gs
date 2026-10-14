// <copyright file="Issue3627VariadicCarrierEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic
import System.Diagnostics

/// ADR-0173 / issue #3627: a variadic parameter with a non-array carrier
/// (`...List[T]`, `...ReadOnlySpan[T]`, …) emits the carrier as
/// the CLR parameter type and stamps C#13's
/// `[ParamCollectionAttribute]`, so C# consumers see exactly
/// `params X<T>`; the array family keeps
/// `[ParamArrayAttribute]`. Runtime behavior is pinned end to end
/// (verified IL, expanded packing, pass-through).
open class Issue3627VariadicCarrierEmitTests {
    @Fact
    func CarrierParameters_EmitCollectionAttributeAndCarrierSignature() {
        let assembly = CompileToAssembly(`package P
import System
import System.Collections.Generic

class Totals {
    shared {
        func Span(values ...ReadOnlySpan[int32]) int32 {
            var t = 0
            for v in values { t = t + v }
            return t
        }

        func Lst(values ...List[int32]) int32 {
            var t = 0
            for v in values { t = t + v }
            return t
        }

        func Seq(values ...IEnumerable[string]) int32 {
            var n = 0
            for v in values { n = n + v.Length }
            return n
        }

        func Classic(values ...int32) int32 {
            var t = 0
            for v in values { t = t + v }
            return t
        }
    }
}`)
        let totals = assembly.GetTypes().Single((t Type) -> t.Name == "Totals")
        AssertParam(totals, "Span", "ReadOnlySpan`1", "ParamCollectionAttribute")
        AssertParam(totals, "Lst", "List`1", "ParamCollectionAttribute")
        AssertParam(totals, "Seq", "IEnumerable`1", "ParamCollectionAttribute")
        AssertParam(totals, "Classic", "Int32[]", "ParamArrayAttribute")
        // Runtime witness through the List carrier (spans cannot box through
        // reflection): the pack really produced a List the body could Count.
        let lst = totals.GetMethod("Lst")!!
        Assert.Equal(9, lst.Invoke(nil, []object{List[int32]{4, 5}}))
    }

    @Fact
    func CarrierCalls_RunEndToEnd() {
        let output = CompileAndRun(`package P
import System
import System.Collections.Generic

func totalSpan(values ...ReadOnlySpan[int32]) int32 {
    var t = 0
    for v in values { t = t + v }
    return t
}

func totalList(values ...List[int32]) int32 {
    var t = 0
    for v in values { t = t + v }
    return t + values.Count
}

func run() {
    Console.WriteLine(totalSpan(1, 2, 3))
    Console.WriteLine(totalList(4, 5))
    let existing = List[int32]()
    existing.Add(10)
    Console.WriteLine(totalList(existing))
}

run()`)
        Assert.Equal("6${Environment.NewLine}11${Environment.NewLine}11${Environment.NewLine}", output)
    }

    shared {
        private func AssertParam(type Type, methodName string, expectedParamTypeName string, expectedAttribute string) {
            let parameter = type.GetMethod(methodName)!!.GetParameters()[0]
            Assert.Equal(
                expectedParamTypeName,
                parameter
                    .ParameterType
                    .Name +
                    (
                    if parameter.ParameterType.IsArray {
                        string.Empty
                    } else {
                        string.Empty
                    }
                )
            )
            Assert.Contains(
                parameter.GetCustomAttributesData(),
                (a CustomAttributeData) -> a.AttributeType.Name == expectedAttribute
            )
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_vcarrier_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            RunGsc([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_vcarrier_run_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                RunGsc([]string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath})
                IlVerifier.Verify(outPath)
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
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func RunGsc(args[]string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }
    }
}
