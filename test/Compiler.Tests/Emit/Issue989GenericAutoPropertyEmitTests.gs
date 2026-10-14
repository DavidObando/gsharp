// <copyright file="Issue989GenericAutoPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #989 regression tests: a generic auto-property (or computed property)
/// whose type mentions the declaring class's type parameter must resolve on a
/// constructed instance with the type argument substituted — exactly like a
/// generic field already did. Previously a read of `b.Value` where
/// `b : Box[int32]` reported `GS0158` "Cannot find member Value"
/// because (cref:GSharp.Core.CodeAnalysis.Symbols.StructSymbol)
/// construction substituted fields but never carried the property table across.
///
/// The tests compile hermetic programs with `gsc` in-process, IL-verify
/// the produced assembly, and execute it to confirm the substituted accessors
/// round-trip a value at runtime.
open class Issue989GenericAutoPropertyEmitTests {
    @Fact
    func GenericAutoProperty_ReadOnConstructedType_Compiles() {
        // The original repro: reading a generic auto-property on a constructed
        // type must bind (no GS0158) and the access reports the substituted
        // type so it can be returned as int32.
        let source = `package T

class Box[T] {
    prop Value T { get; set; }
}

func test(b Box[int32]) int32 {
    return b.Value
}

let bx = Box[int32]()
bx.Value = 5
System.Console.WriteLine(test(bx).ToString())`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericAutoProperty_WriteThenRead_RoundTripsAtRuntime() {
        // End-to-end: write then read a generic auto-property on a constructed
        // type and observe the stored value at runtime.
        let source = `package T
import System

class Box[T](Value T) {
    prop Stored T { get; set; }
}

let b = Box[int32](0)
b.Stored = 42
Console.WriteLine(b.Stored.ToString())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericProperty_ConstructedOverTypeParameter_ResolvesSubstituted() {
        // A property whose type is constructed over the class type parameter
        // ([]T) resolves to []int32 on Box[int32] and round-trips. (List[T] is
        // the same shape but currently hits a separate, pre-existing CLR
        // closed-generic substitution gap that also affects fields, so the
        // slice form is used here to isolate the #989 property-substitution
        // behavior.)
        let source = `package T
import System

class Box[T] {
    prop Items []T { get; set; }
}

let b = Box[int32]()
let arr = []int32{7, 35}
b.Items = arr
Console.WriteLine((b.Items[0] + b.Items[1]).ToString())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue989_").FullName
            try {
                let outPath = Path.Combine(tempDir, "test.dll")
                let (exit, output) = Compile(source, outPath, tempDir)
                Assert.True(exit == 0, "gsc failed: $output")
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
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
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
                TryDeleteDirectory(tempDir)
            }
        }

        private func Compile(source string, outPath string, tempDir string)(Exit int32, Output string) {
            let srcPath = Path.Combine(tempDir, "test.gs")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
            for bcl in BclReferences.Value {
                args.Add("/r:" + bcl)
            }
            args.Add(srcPath)
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
            return (compileExit, (`stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }

        private func TryDeleteDirectory(dir string) {
            try {
                Directory.Delete(dir, recursive: true)
            } catch {
                // Best-effort cleanup; the OS reclaims scratch directories later.

            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
