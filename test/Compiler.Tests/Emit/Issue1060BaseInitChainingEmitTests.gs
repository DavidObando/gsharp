// <copyright file="Issue1060BaseInitChainingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1060: end-to-end CLR emit + ilverify coverage for a derived class
/// constructor initializer (`init(...) : base(args)`) chaining to a base
/// class's explicit `init(...)` member constructors (rather than only a
/// primary constructor). Validates that the resolved base constructor is the
/// one actually invoked in emitted CIL (the `call instance void
/// Base::.ctor(...)` targets the selected overload), that overload selection
/// among multiple explicit base inits is by argument types, and that the
/// pre-existing primary-ctor and CLR-base chaining paths are not regressed.
open class Issue1060BaseInitChainingEmitTests {
    @Fact
    func EndToEnd_ChainToSingleExplicitBaseInit_RunsBaseCtorAndSetsField() {
        let source = `package p
open class A {
    var X int32
    init(x int32) { X = x }
}
class B : A {
    init(x int32) : base(x) { }
}
func Main() {
    var b = B(7)
    System.Console.WriteLine(b.X)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_SelectsAmongMultipleExplicitBaseInitsByArgCount() {
        let source = `package p
open class A {
    var Tag string
    init(x int32) { Tag = "one" }
    init(x int32, y int32) { Tag = "two" }
}
class B : A {
    init() : base(1, 2) { }
}
func Main() {
    var b = B()
    System.Console.WriteLine(b.Tag)
}`
        let output = CompileAndRun(source)
        Assert.Equal("two${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_SelectsAmongMultipleExplicitBaseInitsByArgType() {
        let source = `package p
open class A {
    var Tag string
    init(x int32) { Tag = "int" }
    init(s string) { Tag = "string" }
}
class B : A {
    init() : base("hi") { }
}
func Main() {
    var b = B()
    System.Console.WriteLine(b.Tag)
}`
        let output = CompileAndRun(source)
        Assert.Equal("string${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ChainToBasePrimaryConstructor_StillWorks() {
        let source = `package p
open class A(X int32) {}
class B : A {
    init(x int32) : base(x) {}
    func Read() int32 { return X }
}
func Main() {
    var b = B(42)
    System.Console.WriteLine(b.Read())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ChainToClrBaseConstructor_StillWorks() {
        let source = `package p
class MyError : System.Exception {
    var Code int32
    init(m string, c int32) : base(m) { Code = c }
}
func Main() {
    var e = MyError("boom", 13)
    System.Console.WriteLine(e.Message)
    System.Console.WriteLine(e.Code)
}`
        let output = CompileAndRun(source)
        Assert.Equal("boom${Environment.NewLine}13${Environment.NewLine}", output)
    }

    @Fact
    func Library_ChainToExplicitBaseInit_PassesIlVerify() {
        // ilverify is invoked unconditionally by CompileLibrary; emitting a call
        // to the wrong base .ctor token (e.g. a non-existent parameterless ctor)
        // would fail verification here.
        let source = `package p
open class A {
    var X int32
    init(x int32) { X = x }
    init(x int32, y int32) { X = x + y }
}
class B : A {
    init(x int32) : base(x) { }
    init() : base(1, 2) { }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1060_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1060_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                RunCompiler(args)
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func RunCompiler(args[]string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
