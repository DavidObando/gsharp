// <copyright file="Issue1356FuncReturnCovarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1356: a function-typed value whose return type is a bare type
/// parameter `T` implicitly converts to a function whose return type is the
/// nullable form `T?` of the same type parameter. Widening a non-null value
/// to its nullable form is always safe, so a `(T) -> T` flows into a
/// `(T) -> T?` slot. Issue #2714 also permits the reverse delegate
/// conversion because an unconstrained `T?` annotation does not change
/// the emitted runtime signature.
open class Issue1356FuncReturnCovarianceEmitTests {
    @Fact
    func Library_FuncReturnTypeParameterWidensToNullable_Compiles() {
        // The minimal repro from issue #1356: a `(T) -> T` lambda is stored in a
        // `(T) -> T?` field. Before the fix this errored with GS0155.
        let source = `package p

class Box[T] {
    let f (T) -> T?
    init(g (T) -> T) {
        this.f = g
    }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func Library_ConcreteReferenceReturnWidensToNullable_StillCompiles() {
        // Control: concrete reference return widening must keep working.
        let source = `package p

class Box {
    let f (int32) -> string?
    init(g (int32) -> string) {
        this.f = g
    }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func Library_ReferenceCovariantReturn_StillCompiles() {
        // Control: reference covariance on the return type must keep working.
        let source = `package p

class Box {
    let f () -> object
    init(g () -> string) {
        this.f = g
    }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func Library_NullableReturnConvertsToSameRuntimeSignature() {
        let source = `package p

class Box[T] {
    let f (T) -> T
    init(g (T) -> T?) {
        this.f = g
    }
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    @Fact
    func EndToEnd_BoxOfString_StoresAndInvokesNullableReturningField() {
        // A `Box[string]` built from a `(string) -> string` lambda stores the
        // lambda in its `(string) -> string?` field and invoking it returns a
        // `string?` carrying the computed value at runtime. A reference-type
        // reification exercises the conversion soundly: `string?` shares the CLR
        // representation of `string`, so the widened function is the same
        // delegate and the runtime value flows through unchanged.
        let source = `package p

class Box[T] {
    let f (T) -> T?
    init(g (T) -> T) {
        this.f = g
    }

    func apply(x T) T? {
        return this.f(x)
    }
}

func Main() {
    let b = Box[string](func (x string) string { return x + "!" })
    System.Console.WriteLine(b.apply("hi"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hi!${Environment.NewLine}", output)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1356_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            RunCompiler(args)
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func TryCompileLibrary(source string)(Exit int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1356_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
                return (compileExit, stdoutWriter.ToString(), stderrWriter.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1356_exe_").FullName
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
