// <copyright file="Issue1733FloatInfinityDefaultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1733 N1: <c>cs2gs</c> emits a <c>double</c>/<c>float</c>
/// <c>PositiveInfinity</c>/<c>NegativeInfinity</c> default as the qualified BCL
/// member reference <c>System.Double.PositiveInfinity</c>/<c>NegativeInfinity</c>
/// (and the <c>System.Single</c> equivalents) — the same spelling
/// <c>Issue1616FloatNaNOperatorEmitTests</c> already proves G# resolves for
/// <c>System.Double.NaN</c>/<c>System.Single.NaN</c>. This end-to-end emit test
/// proves G# ALSO resolves the <c>PositiveInfinity</c>/<c>NegativeInfinity</c>
/// spelling for both <c>double</c> and <c>float</c>, confirming the cs2gs emitted
/// spelling is correct (not just NaN).
/// </summary>
public class Issue1733FloatInfinityDefaultEmitTests
{
    [Fact]
    public void EndToEnd_Float64_PositiveAndNegativeInfinity_Resolve()
    {
        const string source = """
            package i1733f64inf
            import System

            func Main() {
                var posInf = System.Double.PositiveInfinity
                var negInf = System.Double.NegativeInfinity
                System.Console.WriteLine(posInf)
                System.Console.WriteLine(negInf)
                System.Console.WriteLine(posInf > 1.0)
                System.Console.WriteLine(negInf < -1.0)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("\u221e\n-\u221e\nTrue\nTrue\n", output);
    }

    [Fact]
    public void EndToEnd_Float32_PositiveAndNegativeInfinity_Resolve()
    {
        const string source = """
            package i1733f32inf
            import System

            func Main() {
                var posInf = System.Single.PositiveInfinity
                var negInf = System.Single.NegativeInfinity
                System.Console.WriteLine(posInf)
                System.Console.WriteLine(negInf)
                System.Console.WriteLine(posInf > float32(1.0))
                System.Console.WriteLine(negInf < float32(-1.0))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("\u221e\n-\u221e\nTrue\nTrue\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1733inf_exe_").FullName;
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
