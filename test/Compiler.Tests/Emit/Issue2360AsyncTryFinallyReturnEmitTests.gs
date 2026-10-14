// <copyright file="Issue2360AsyncTryFinallyReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2360: end-to-end compile+run coverage for the fix in
/// (cref:Core.CodeAnalysis.Binding.ControlFlowGraph.GraphBuilder). An
/// async function containing both a by-ref-like (`ref struct`) local —
/// legalized per-scope by issue #2350's
/// (cref:Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer) —
/// and a `return` lexically inside a `try`/`finally` crashed
/// the compiler with GS9998 (`KeyNotFoundException`) instead of binding
/// and emitting correctly. `Lowerer.RewriteReturnStatement` rewrites
/// that `return` into a store-to-temp + `goto` targeting a
/// synthesized method-exit label placed <em>outside</em> the try statement;
/// (cref:Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer)
/// then analyzes the try body in a region-scoped
/// (cref:Core.CodeAnalysis.Binding.ControlFlowGraph) that never
/// contains that label. The fix makes an escaping goto target resolve to the
/// region's end block (like `return`/`throw` already do) instead of
/// throwing. These tests compile and *run* the fixed program, asserting both
/// the correct return value and that the `finally` block's side effect
/// actually executed — not just that binding no longer crashes.
open class Issue2360AsyncTryFinallyReturnEmitTests {
    @Fact
    func PipelineProbeCheck_ExactIssueRepro_ReturnInTryFinally_NoAwait_CompilesRunsAndDisposes() {
        // The exact minimal repro from issue #2360.
        const source = `package i2360exact
import System
import System.IO
import System.Threading.Tasks

async func PipelineProbeCheck(buffer []byte) Task[int32] {
    var span ReadOnlySpan[byte] = buffer
    var len = span.Length
    var ms = MemoryStream()
    try {
        return len
    } finally {
        ms.Dispose()
        Console.WriteLine("disposed")
    }
}

var data []byte = []byte{1, 2, 3, 4, 5}
Console.WriteLine(PipelineProbeCheck(data).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("disposed${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func PipelineProbeCheck_ReturnInTryFinally_WithRealAwaitElsewhere_CompilesRunsAndDisposes() {
        const source = `package i2360await
import System
import System.IO
import System.Threading.Tasks

async func PipelineProbeCheck(buffer []byte) Task[int32] {
    await Task.Yield()
    var span ReadOnlySpan[byte] = buffer
    var len = span.Length
    var ms = MemoryStream()
    try {
        return len
    } finally {
        ms.Dispose()
        Console.WriteLine("disposed")
    }
}

var data []byte = []byte{1, 2, 3, 4, 5, 6, 7}
Console.WriteLine(PipelineProbeCheck(data).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("disposed${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func UsingLetDesugaredForm_ReturnInsideUsingScope_CompilesRunsAndDisposes() {
        // `using let` desugars to try/finally with Dispose() in the finally —
        // this exercises the identical escaping-goto shape via the
        // higher-level `using let` syntax rather than a hand-written
        // try/finally.
        const source = `package i2360usinglet
import System
import System.Threading.Tasks

class Fixture : IDisposable {
    func Dispose() {
        Console.WriteLine("disposed")
    }
}

async func RunAsync(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    using let f = Fixture{}
    return len
}

var data []int32 = []int32{1, 2, 3}
Console.WriteLine(RunAsync(data).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("disposed${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func MultipleReturnsInSeparateTryFinallyBlocks_CompilesAndRuns() {
        const source = `package i2360multi
import System
import System.Threading.Tasks

async func RunAsync(arr []int32, flag bool) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    if flag {
        try {
            return len
        } finally {
            Console.WriteLine("first")
        }
    }

    try {
        return len + 100
    } finally {
        Console.WriteLine("second")
    }
}

var data []int32 = []int32{1, 2, 3, 4}
Console.WriteLine(RunAsync(data, true).Result)
Console.WriteLine(RunAsync(data, false).Result)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "first${Environment.NewLine}4${Environment.NewLine}second${Environment.NewLine}104${Environment.NewLine}",
            output
        )
    }

    @Fact
    func NestedTryFinally_ReturnInInnermostTry_CompilesAndRuns() {
        const source = `package i2360nested
import System
import System.Threading.Tasks

async func RunAsync(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        try {
            return len
        } finally {
            Console.WriteLine("inner")
        }
    } finally {
        Console.WriteLine("outer")
    }
}

var data []int32 = []int32{1, 2, 3, 4, 5}
Console.WriteLine(RunAsync(data).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("inner${Environment.NewLine}outer${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func ReturnInsideTryCatchFinally_NoAwait_CompilesAndRuns() {
        const source = `package i2360catch
import System
import System.Threading.Tasks

async func RunAsync(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        return len
    } catch (e Exception) {
        return -1
    } finally {
        Console.WriteLine("cleanup")
    }
}

var data []int32 = []int32{9, 9, 9}
Console.WriteLine(RunAsync(data).Result)`
        let output = CompileAndRun(source)
        Assert.Equal("cleanup${Environment.NewLine}3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2360tryfinally_exe_").FullName
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
