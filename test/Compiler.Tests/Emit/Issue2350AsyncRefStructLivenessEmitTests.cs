// <copyright file="Issue2350AsyncRefStructLivenessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2350: end-to-end compile+run coverage for
/// <see cref="Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer"/>. A
/// by-ref-like (<c>ref struct</c>) local such as <c>ReadOnlySpan[T]</c> is now
/// permitted in an async function/lambda as long as it is proven never live
/// across an <c>await</c> suspension point. These tests force genuine
/// <c>MoveNext</c> suspension via <c>await Task.Yield()</c> so the correctness
/// of the underlying async lowering (which never hoists a by-ref-like local
/// into a state-machine field — see <c>AsyncCaptureWalker</c>) is actually
/// exercised end to end, not merely accepted by the binder.
/// </summary>
public class Issue2350AsyncRefStructLivenessEmitTests
{
    [Fact]
    public void PipelineProbeCheck_PerIterationSpanDeadBeforeAwait_CompilesAndRuns()
    {
        const string source = """
            package i2350pipelineprobe
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
            Console.WriteLine(PipelineProbeCheck(data, 3).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void SpanLocal_ConsumedBeforeAwait_ReusedAcrossMultipleAwaits_CompilesAndRuns()
    {
        const string source = """
            package i2350reuse
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
            Console.WriteLine(RunAsync(a, b).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void SpanLocal_ConsumedEntirelyInTry_FinallyAwaitsSeparately_CompilesAndRuns()
    {
        const string source = """
            package i2350tryfinally
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
            Console.WriteLine(RunAsync(data).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void SpanLocal_InNestedAsyncLambda_DeadBeforeOwnAwait_CompilesAndRuns()
    {
        const string source = """
            package i2350nestedlambda
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
            Console.WriteLine(RunAsync(data).Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2350liveness_exe_").FullName;
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
