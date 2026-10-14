// <copyright file="Issue1904AsyncEntryPointEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1904 — an `async` entry point (either the synthesized
/// top-level-statement `<Main>$` when a top-level `await` is
/// present, or a user-authored `async func Main()`) used to emit a
/// `Task`/`Task<T>`-returning CLR entry point. The runtime
/// rejects that at process start with
/// `MethodAccessException: "Entry point must have a return type of void,
/// integer, or unsigned integer."` — a SILENT divergence (gsc compiles and
/// ilverifies the assembly fine; only running it fails).
///
/// The fix: when the async kickoff method is also the CLR entry point, the
/// emitter no longer returns `builder.Task` — it blocks on it right there
/// with the same `GetAwaiter().GetResult()` drive C# generates for
/// `async Task Main()`, and the CLR signature stays the function's
/// declared void/int32 shape.
///
/// Each fact uses a UNIQUE package name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed (see Issue1502 emit tests).
open class Issue1904AsyncEntryPointEmitTests {
    @Fact
    func TopLevelAwait_EntryPoint_RunsAndReturnsVoid() {
        const source = `package i1904tlsvoid
import System
import System.Threading.Tasks

Console.WriteLine("start")
await Task.Delay(1)
Console.WriteLine("end")`
        let output = CompileAndRun(source, expectedExitCode: 0)
        Assert.Equal("start${Environment.NewLine}end${Environment.NewLine}", output)
    }

    @Fact
    func TopLevelAwait_EntryPoint_ReturnValue_BecomesProcessExitCode() {
        const source = `package i1904tlsint
import System
import System.Threading.Tasks

Console.WriteLine("start")
await Task.Delay(1)
return 42`
        let output = CompileAndRun(source, expectedExitCode: 42)
        Assert.Equal("start${Environment.NewLine}", output)
    }

    @Fact
    func ExplicitTopLevelAsyncFuncMain_Void_RunsAndReturnsVoid() {
        const source = `package i1904explicitvoid
import System
import System.Threading.Tasks

async func Main() {
    Console.WriteLine("start")
    await Task.Delay(1)
    Console.WriteLine("end")
}`
        let output = CompileAndRun(source, expectedExitCode: 0)
        Assert.Equal("start${Environment.NewLine}end${Environment.NewLine}", output)
    }

    @Fact
    func ExplicitTopLevelAsyncFuncMain_Int_ReturnValueBecomesProcessExitCode() {
        const source = `package i1904explicitint
import System
import System.Threading.Tasks

async func Main() int32 {
    Console.WriteLine("start")
    await Task.Delay(1)
    return 7
}`
        let output = CompileAndRun(source, expectedExitCode: 7)
        Assert.Equal("start${Environment.NewLine}", output)
    }

    @Fact
    func ExplicitTopLevelAsyncFuncMain_WithArgsParameter_Runs() {
        const source = `package i1904explicitargs
import System
import System.Threading.Tasks

async func Main(args []string) {
    Console.WriteLine(args.Length)
    await Task.Delay(1)
}`
        let output = CompileAndRun(source, expectedExitCode: 0)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    shared {
        /// Copied verbatim from `Issue1502DelegateUserTypeArgEmitTests.CompileAndRun`
        /// (test/Compiler.Tests/Emit/Issue1502DelegateUserTypeArgEmitTests.cs),
        /// with the hard-coded `proc.ExitCode == 0` assertion parameterized so
        /// this suite can also prove an async entry point's `return N` becomes
        /// the real CLR process exit code (issue #1904).
        private func CompileAndRun(source string, expectedExitCode int32) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1904_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                Assert.True(
                    proc.ExitCode == expectedExitCode,
                    (`expected exit ` + "$expectedExitCode" + `, got ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
                )
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
