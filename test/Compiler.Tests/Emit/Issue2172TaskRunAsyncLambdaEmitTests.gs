// <copyright file="Issue2172TaskRunAsyncLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2172: `Task.Run(async () -> await ...)`, where the async
/// lambda awaits a `Task[T]`, must resolve to the
/// `Task.Run(Func<Task<TResult>>)` overload (returning
/// `Task[X]`) rather than being ambiguous with
/// `Task.Run(Func<TResult>)` (which would return
/// `Task[Task[X]]`). These emit tests prove the resolved call not only
/// compiles but produces IL that runs and returns the awaited result correctly.
/// A parallel test covers a user-defined overload set (NOT `Task.Run`) to
/// prove the betterness rule is generalized, not hard-coded to the BCL method.
open class Issue2172TaskRunAsyncLambdaEmitTests {
    @Fact
    func TaskRun_AsyncLambda_ReturnsAwaitedResult() {
        const source = `package i2172run
import System
import System.Threading.Tasks

func makeAsync() Task[int32] -> Task.FromResult(42)

func get() int32 {
    let task = Task.Run(async () -> await makeAsync())
    return task.Result
}

Console.WriteLine(get())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func TaskRun_AsyncLambda_StringResult_ReturnsAwaitedResult() {
        const source = `package i2172str
import System
import System.Threading.Tasks

func makeAsync() Task[string] -> Task.FromResult("hello")

func get() string {
    let task = Task.Run(async () -> await makeAsync())
    return task.Result
}

Console.WriteLine(get())`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func UserOverloadSet_FuncXVersusFuncTaskX_PrefersTaskReturningOverloadAtRuntime() {
        // Generalized (NOT Task.Run): a user-defined overload set differing only
        // by `() -> T` vs `() -> Task[T]`. The task-returning async lambda must
        // bind to the `() -> Task[T]` overload; the awaited result flows back
        // through `.Result`. If the `() -> T` overload were chosen, `run` would
        // return a Task and the `int32`-typed local would not compile.
        const source = `package i2172gen
import System
import System.Threading.Tasks

func makeAsync() Task[int32] -> Task.FromResult(7)

func run(f () -> int32) int32 -> f()
func run(f () -> Task[int32]) int32 -> f().Result

func use() int32 -> run(async () -> await makeAsync())

Console.WriteLine(use())`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2172_exe_").FullName
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
    }
}
