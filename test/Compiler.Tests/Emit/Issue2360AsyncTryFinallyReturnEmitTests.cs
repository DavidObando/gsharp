// <copyright file="Issue2360AsyncTryFinallyReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2360: end-to-end compile+run coverage for the fix in
/// <see cref="Core.CodeAnalysis.Binding.ControlFlowGraph.GraphBuilder"/>. An
/// async function containing both a by-ref-like (<c>ref struct</c>) local —
/// legalized per-scope by issue #2350's
/// <see cref="Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer"/> —
/// and a <c>return</c> lexically inside a <c>try</c>/<c>finally</c> crashed
/// the compiler with GS9998 (<c>KeyNotFoundException</c>) instead of binding
/// and emitting correctly. <c>Lowerer.RewriteReturnStatement</c> rewrites
/// that <c>return</c> into a store-to-temp + <c>goto</c> targeting a
/// synthesized method-exit label placed <em>outside</em> the try statement;
/// <see cref="Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer"/>
/// then analyzes the try body in a region-scoped
/// <see cref="Core.CodeAnalysis.Binding.ControlFlowGraph"/> that never
/// contains that label. The fix makes an escaping goto target resolve to the
/// region's end block (like <c>return</c>/<c>throw</c> already do) instead of
/// throwing. These tests compile and *run* the fixed program, asserting both
/// the correct return value and that the <c>finally</c> block's side effect
/// actually executed — not just that binding no longer crashes.
/// </summary>
public class Issue2360AsyncTryFinallyReturnEmitTests
{
    [Fact]
    public void PipelineProbeCheck_ExactIssueRepro_ReturnInTryFinally_NoAwait_CompilesRunsAndDisposes()
    {
        // The exact minimal repro from issue #2360.
        const string source = """
            package i2360exact
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
            Console.WriteLine(PipelineProbeCheck(data).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("disposed\n5\n", output);
    }

    [Fact]
    public void PipelineProbeCheck_ReturnInTryFinally_WithRealAwaitElsewhere_CompilesRunsAndDisposes()
    {
        const string source = """
            package i2360await
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
            Console.WriteLine(PipelineProbeCheck(data).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("disposed\n7\n", output);
    }

    [Fact]
    public void UsingLetDesugaredForm_ReturnInsideUsingScope_CompilesRunsAndDisposes()
    {
        // `using let` desugars to try/finally with Dispose() in the finally —
        // this exercises the identical escaping-goto shape via the
        // higher-level `using let` syntax rather than a hand-written
        // try/finally.
        const string source = """
            package i2360usinglet
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
            Console.WriteLine(RunAsync(data).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("disposed\n3\n", output);
    }

    [Fact]
    public void MultipleReturnsInSeparateTryFinallyBlocks_CompilesAndRuns()
    {
        const string source = """
            package i2360multi
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
            Console.WriteLine(RunAsync(data, false).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("first\n4\nsecond\n104\n", output);
    }

    [Fact]
    public void NestedTryFinally_ReturnInInnermostTry_CompilesAndRuns()
    {
        const string source = """
            package i2360nested
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
            Console.WriteLine(RunAsync(data).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("inner\nouter\n5\n", output);
    }

    [Fact]
    public void ReturnInsideTryCatchFinally_NoAwait_CompilesAndRuns()
    {
        const string source = """
            package i2360catch
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
            Console.WriteLine(RunAsync(data).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("cleanup\n3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2360tryfinally_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
