// <copyright file="Issue640FieldInitializerEmitTests.cs" company="GSharp">
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

/// Issue #640: class field initializers (`field T = expr`) must be
/// evaluated at construction time and emitted into every constructor body.
/// Each test compiles via `gsc`, ilverifies the produced PE, then
/// executes the assembly under `dotnet exec` and asserts on the
/// captured stdout.
open class Issue640FieldInitializerEmitTests {
    @Fact
    func Int32_Field_Initializer() {
        let source = `package P
import System

class Holder {
    var n int32 = 42
    func Get() int32 { return n }
}

var h = Holder()
Console.WriteLine(h.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Int64_Field_Initializer() {
        let source = `package P
import System

class Holder {
    var n int64 = 100
    func Get() int64 { return n }
}

var h = Holder()
Console.WriteLine(h.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("100${Environment.NewLine}", output)
    }

    @Fact
    func Bool_Field_Initializer() {
        let source = `package P
import System

class Holder {
    var flag bool = true
    func Get() bool { return flag }
}

var h = Holder()
Console.WriteLine(h.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func String_Field_Initializer() {
        let source = `package P
import System

class Holder {
    var s string = "hello"
    func Get() string { return s }
}

var h = Holder()
Console.WriteLine(h.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func Computed_Expression_Initializer() {
        let source = `package P
import System

class Holder {
    var c int32 = 1 + 2 * 3
    func Get() int32 { return c }
}

var h = Holder()
Console.WriteLine(h.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func PrimaryConstructorParameter_FieldInitializer() {
        let source = `package P
import System

class Holder(value string) {
    let normalized string = value.ToUpperInvariant()
    func Get() string -> normalized
}

Console.WriteLine(Holder("hello").Get())`
        let output = CompileAndRun(source)
        Assert.Equal("HELLO${Environment.NewLine}", output)
    }

    @Fact
    func InterpolatedString_FieldInitializer() {
        let source = `package P
import System

class Holder {
    let workerId string = "worker:${Environment.ProcessId}"
    func Get() string -> workerId
}

Console.WriteLine(Holder().Get().StartsWith("worker:"))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func InterpolatedString_StaticAndInterfaceFieldInitializers() {
        let source = `package P
import System

class Holder {
    shared {
        let WorkerId string = "class:${Environment.ProcessId}"
    }
}

interface IHolder {
    shared {
        let WorkerId string = "interface:${Environment.ProcessId}"
    }
}

Console.WriteLine(Holder.WorkerId.StartsWith("class:"))
Console.WriteLine(IHolder.WorkerId.StartsWith("interface:"))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func PrimaryConstructor_HasSinglePublicConstructor() {
        let source = `package P
import System

class Holder(value string) {
    func Get() string -> value
}

Console.WriteLine(Holder("x").GetType().GetConstructors().Length)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func Multiple_Fields_With_Initializers() {
        let source = `package P
import System

class Multi {
    var a int32 = 10
    var b int32 = 20
    var c string = "abc"
    func Show() string {
        return a.ToString() + "," + b.ToString() + "," + c
    }
}

var m = Multi()
Console.WriteLine(m.Show())`
        let output = CompileAndRun(source)
        Assert.Equal("10,20,abc${Environment.NewLine}", output)
    }

    @Fact
    func Initializer_Runs_With_ExplicitInit_Constructor() {
        // Field initializers run BEFORE the user-authored init body.
        let source = `package P
import System

class Widget {
    var baseValue int32 = 100
    var extra int32

    init(e int32) {
        extra = e
    }

    func Total() int32 { return baseValue + extra }
}

var w = Widget(5)
Console.WriteLine(w.Total())`
        let output = CompileAndRun(source)
        Assert.Equal("105${Environment.NewLine}", output)
    }

    @Fact
    func Initializer_Runs_With_PrimaryConstructor() {
        let source = `package P
import System

class Thing(name string) {
    var prefix string = "Item:"
    func Label() string { return prefix + name }
}

var t = Thing("foo")
Console.WriteLine(t.Label())`
        let output = CompileAndRun(source)
        Assert.Equal("Item:foo${Environment.NewLine}", output)
    }

    @Fact
    func Initializer_Runs_For_All_Constructor_Overloads() {
        // Use a single init(x int32) to confirm field initializer still runs.
        let source = `package P
import System

class Dual {
    var tag string = "default"
    var n int32

    init(x int32) {
        n = x
    }

    func Show() string { return tag + ":" + n.ToString() }
}

var b = Dual(7)
Console.WriteLine(b.Show())`
        let output = CompileAndRun(source)
        Assert.Equal("default:7${Environment.NewLine}", output)
    }

    @Fact
    func Inheritance_DerivedFieldInitializers_Run() {
        let source = `package P
import System

open class Base {
    var baseVal int32 = 1
    func GetBase() int32 { return baseVal }
}

class Derived : Base {
    var derivedVal int32 = 2
    func GetDerived() int32 { return derivedVal }
}

var d = Derived()
Console.WriteLine(d.GetBase())
Console.WriteLine(d.GetDerived())`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func Field_Without_Initializer_StillDefaultsToZero() {
        // Regression guard: fields without initializers must still default.
        let source = `package P
import System

class Mixed {
    var initialized int32 = 42
    var uninitialized int32
    func Show() string {
        return initialized.ToString() + "," + uninitialized.ToString()
    }
}

var m = Mixed()
Console.WriteLine(m.Show())`
        let output = CompileAndRun(source)
        Assert.Equal("42,0${Environment.NewLine}", output)
    }

    @Fact
    func Double_Field_Initializer() {
        let source = `package P
import System

class Holder {
    var d float64 = 3.14
    func Get() float64 { return d }
}

var h = Holder()
Console.WriteLine(h.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("3.14${Environment.NewLine}", output)
    }

    @Fact
    func ExplicitInit_CanOverrideFieldInitializer() {
        // The user-defined init body runs AFTER field initializers,
        // so it can override the field's initial value.
        let source = `package P
import System

class Override {
    var n int32 = 10

    init(value int32) {
        n = value
    }

    func Get() int32 { return n }
}

var o = Override(99)
Console.WriteLine(o.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    shared {
        // Test infrastructure — mirrors Issue524DefaultCtorEmitTests pattern.
        private func CompileAndRun(source string) string {
            let (exit, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exit == 0, (`exited ` + "$exit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue640_").FullName
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
                    stderr.ReplaceLineEndings(Environment.NewLine)
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
