// <copyright file="Issue2350AsyncRefStructLivenessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2350: end-to-end compile+run coverage for
/// (cref:Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer). A
/// by-ref-like (`ref struct`) local such as `ReadOnlySpan[T]` is now
/// permitted in an async function/lambda as long as it is proven never live
/// across an `await` suspension point. These tests force genuine
/// `MoveNext` suspension via `await Task.Yield()` so the correctness
/// of the underlying async lowering (which never hoists a by-ref-like local
/// into a state-machine field — see `AsyncCaptureWalker`) is actually
/// exercised end to end, not merely accepted by the binder.
open class Issue2350AsyncRefStructLivenessEmitTests {
    @Fact
    func PipelineProbeCheck_PerIterationSpanDeadBeforeAwait_CompilesAndRuns() {
        const source = `package i2350pipelineprobe
import System
import System.Threading.Tasks

async func PipelineProbeCheck(buffer []byte, probeCount int32) Task[int32] {
    var total = 0
    for var i = 0; i < probeCount; i++ {
        var probe ReadOnlySpan[byte] = buffer
        total = total + probe.Length
        await Task.Yield()
    }
    return total
}

var data []byte = []byte{1, 2, 3, 4, 5}
Console.WriteLine(PipelineProbeCheck(data, 3).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func SpanLocal_ConsumedBeforeAwait_ReusedAcrossMultipleAwaits_CompilesAndRuns() {
        const source = `package i2350reuse
import System
import System.Threading.Tasks

async func RunAsync(a []int32, b []int32) Task[int32] {
    var s ReadOnlySpan[int32] = a
    var first = s.Length
    await Task.Yield()
    s = b
    var second = s.Length
    await Task.Yield()
    return first + second
}

var a []int32 = []int32{1, 2, 3}
var b []int32 = []int32{10, 20}
Console.WriteLine(RunAsync(a, b).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func SpanLocal_ConsumedEntirelyInTry_FinallyAwaitsSeparately_CompilesAndRuns() {
        const source = `package i2350tryfinally
import System
import System.Threading.Tasks

async func RunAsync(arr []int32) Task[int32] {
    var total = 0
    try {
        var s ReadOnlySpan[int32] = arr
        total = s.Length
    } finally {
        await Task.Yield()
    }
    return total
}

var data []int32 = []int32{7, 8, 9, 10}
Console.WriteLine(RunAsync(data).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    @Fact
    func SpanLocal_InNestedAsyncLambda_DeadBeforeOwnAwait_CompilesAndRuns() {
        const source = `package i2350nestedlambda
import System
import System.Threading.Tasks

func RunAsync(arr []int32) Task[int32] {
    var g = async func() int32 {
        var s ReadOnlySpan[int32] = arr
        var len = s.Length
        await Task.Yield()
        return len
    }
    return g()
}

var data []int32 = []int32{1, 2, 3, 4, 5, 6}
Console.WriteLine(RunAsync(data).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2350liveness_exe_").FullName
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
