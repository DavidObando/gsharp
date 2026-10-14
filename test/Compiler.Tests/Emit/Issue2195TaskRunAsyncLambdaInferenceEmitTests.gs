// <copyright file="Issue2195TaskRunAsyncLambdaInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2195: inferring a generic method's type argument from an ASYNC lambda
/// whose body `await`s a generic awaitable. When `Task.Run(async () ->
/// await Inner[T]())` awaits a `ValueTask[T]`, the awaited element type
/// must be recovered as `T` (not the erased `object`), so
/// `Task.Run`'s `TResult` infers to `T` and `task.Result`
/// round-trips the value. These emit tests prove the inferred call runs and
/// returns the awaited result for both `ValueTask[T]` and `Task[T]`.
open class Issue2195TaskRunAsyncLambdaInferenceEmitTests {
    @Fact
    func TaskRun_InfersFromAwaitedValueTask_ReturnsAwaitedResult() {
        // The awaited element is a same-compilation user type (`Box`), whose
        // CLR type is erased to `object` inside `ValueTask[Box]`. Before the
        // fix, `Task.Run`'s TResult inferred to `object`, so `task.Result`
        // could not convert to the declared `Box`. The recovered element type
        // must be `Box`, so `task.Result.Value` round-trips 42.
        const source = `package i2195vt
import System
import System.Threading.Tasks

class Box {
    var Value int32
    init(v int32) {
        Value = v
    }
}

func inner(b Box) ValueTask[Box] -> ValueTask[Box](b)

func get(b Box) Box {
    let task = Task.Run(async () -> await inner(b))
    return task.Result
}

Console.WriteLine(get(Box(42)).Value)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func TaskRun_InfersFromAwaitedTask_ReturnsAwaitedResult() {
        // The `Task[Box]` variant of the same erased-user-type awaitable.
        const source = `package i2195t
import System
import System.Threading.Tasks

class Box {
    var Value int32
    init(v int32) {
        Value = v
    }
}

func inner(b Box) Task[Box] -> Task.FromResult(b)

func get(b Box) Box {
    let task = Task.Run(async () -> await inner(b))
    return task.Result
}

Console.WriteLine(get(Box(7)).Value)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2195_exe_").FullName
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
