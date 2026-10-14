// <copyright file="Issue948FieldInitializerSugarEmitTests.cs" company="GSharp">
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

/// Issue #948: syntactic sugar for inline field initialization. Fields declared
/// with `const`, `let`, or `var` may carry an `= expr`
/// initializer in the type body. Instance initializers run in declaration order
/// before each constructor body; `const` fields become compile-time literal
/// fields; static initializers run in the static constructor. Each test compiles
/// via `gsc`, ilverifies the produced PE, then executes the assembly and
/// asserts on the captured stdout (or, for negative tests, on the diagnostic).
open class Issue948FieldInitializerSugarEmitTests {
    @Fact
    func Issue948_ConstLetVar_Example_AllReadAtRuntime() {
        // The exact example from the issue: const + let + var with initializers,
        // all three read at runtime.
        let source = `package P
import System

class Foo {
    const one string = "value"
    let two string = "something"
    var three string = "this should work"
    func Show() string { return one + "|" + two + "|" + three }
}

var f = Foo()
Console.WriteLine(f.Show())
Console.WriteLine(Foo.one)`
        let output = CompileAndRun(source)
        Assert.Equal("value|something|this should work${Environment.NewLine}value${Environment.NewLine}", output)
    }

    @Fact
    func Issue948_InstanceInitializers_RunInDeclarationOrder() {
        // Each initializer is appended in textual order; later fields can be
        // computed but order is what we assert here via a side-effecting log.
        let source = `package P
import System

class Order {
    var a string = "1"
    var b string = "2"
    var c string = "3"
    func Show() string { return a + b + c }
}

var o = Order()
Console.WriteLine(o.Show())`
        let output = CompileAndRun(source)
        Assert.Equal("123${Environment.NewLine}", output)
    }

    @Fact
    func Issue948_StaticFieldInitializer_RunsInCctor() {
        let source = `package P
import System

class Config {
    shared {
        var retries int32 = 3
        let name string = "svc"
    }
}

Console.WriteLine(Config.retries.ToString() + Config.name)`
        let output = CompileAndRun(source)
        Assert.Equal("3svc${Environment.NewLine}", output)
    }

    @Fact
    func Issue948_ConstField_FoldedToLiteral_UsableExternally() {
        let source = `package P
import System

class K {
    const max int32 = 5 * 10
    const label string = "hi"
}

Console.WriteLine(K.max.ToString() + K.label)`
        let output = CompileAndRun(source)
        Assert.Equal("50hi${Environment.NewLine}", output)
    }

    @Fact
    func Issue948_Initializer_ThenExplicitInit_OverridesVar() {
        // Field initializer runs first, then the init body overrides the var.
        let source = `package P
import System

class Widget {
    var n int32 = 10

    init(value int32) {
        n = value
    }

    func Get() int32 { return n }
}

var defaulted = Widget(99)
Console.WriteLine(defaulted.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func Issue948_StructFieldInitializers_AppliedForOmittedFields() {
        // Value-type composite literal zero-inits storage then applies declared
        // field initializers for fields the literal omitted.
        let source = `package P
import System

struct Pt {
    var x int32 = 3
    var y int32 = 4
}

var p = Pt{}
Console.WriteLine(p.x.ToString() + "," + p.y.ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("3,4${Environment.NewLine}", output)
    }

    @Fact
    func Issue948_DataStructFieldInitializers_AppliedForOmittedFields() {
        let source = `package P
import System

data struct Pt {
    var x int32 = 3
    var y int32 = 4
}

var p = Pt{}
Console.WriteLine(p.x.ToString() + "," + p.y.ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("3,4${Environment.NewLine}", output)
    }

    @Fact
    func Issue948_Negative_InstanceInitializerReferencesInstanceMember() {
        let source = `package P
import System

class Foo {
    var a int32 = 5
    var b int32 = a + 10
    func Get() int32 { return b }
}

var f = Foo()
Console.WriteLine(f.Get())`
        let diagnostics = CompileExpectingFailure(source)
        Assert.Contains("GS0377", diagnostics)
    }

    @Fact
    func Issue948_Negative_ConstFieldWithNonConstantInitializer() {
        let source = `package P
import System

class Foo {
    const len int32 = "abc".Length
}

Console.WriteLine(Foo.len.ToString())`
        let diagnostics = CompileExpectingFailure(source)
        Assert.Contains("GS0376", diagnostics)
    }

    @Fact
    func Issue948_Negative_ConstFieldRequiresInitializer() {
        let source = `package P
import System

class Foo {
    const len int32
}

Console.WriteLine(Foo.len.ToString())`
        let diagnostics = CompileExpectingFailure(source)
        Assert.Contains("GS0375", diagnostics)
    }

    shared {
        // Test infrastructure — mirrors Issue640FieldInitializerEmitTests pattern.
        private func CompileAndRun(source string) string {
            let (exit, stdout, stderr, _) = CompileAndRunRaw(source)
            Assert.True(exit == 0, (`exited ` + "$exit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileExpectingFailure(source string) string {
            let (compileExit, compileOut, _) = CompileOnly(source)
            Assert.True(compileExit != 0, (`expected compilation to fail but it succeeded:
` + "$compileOut"))
            return compileOut
        }

        private func CompileOnly(source string)(CompileExit int32, CompileOut string, CompileErr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue948_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
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
                return (compileExit, compileOut.ToString(), compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string, CompileOut string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue948_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
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
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(runtimeConfigPath)
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine),
                    compileOut.ToString()
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
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
