// <copyright file="Issue1616FloatNaNOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1616: float <c>&lt;=</c>/<c>&gt;=</c> operator emit
/// (<c>MethodBodyEmitter.Operators.cs</c> <c>EmitBinary</c> and the lifted
/// <c>EmitUnderlyingOrdering</c>) lowered `a &lt;= b` / `a &gt;= b` as `!(a
/// cgt b)` / `!(a clt b)` using the ORDERED <c>cgt</c>/<c>clt</c> opcodes.
/// Ordered comparisons return false for NaN, so negating them yielded
/// <c>true</c> for e.g. <c>NaN &lt;= 1.0</c> — wrong per IEEE 754. Fix uses
/// the unordered <c>cgt.un</c>/<c>clt.un</c> forms for float operands (as the
/// relational-pattern emit path already did), so negation correctly yields
/// <c>false</c> whenever an operand is NaN.
/// </summary>
public class Issue1616FloatNaNOperatorEmitTests
{
    [Fact]
    public void EndToEnd_Float64_NaNLessOrEqualGreaterOrEqual_AreFalse()
    {
        const string source = """
            package i1616f64op
            import System

            func Main() {
                var nan = System.Double.NaN
                var one = 1.0
                System.Console.WriteLine(nan <= one)
                System.Console.WriteLine(one <= nan)
                System.Console.WriteLine(nan >= one)
                System.Console.WriteLine(one >= nan)
                System.Console.WriteLine(one <= 2.0)
                System.Console.WriteLine(2.0 >= one)
                System.Console.WriteLine(one <= 1.0)
                System.Console.WriteLine(one >= 1.0)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nFalse\nFalse\nFalse\nTrue\nTrue\nTrue\nTrue\n", output);
    }

    [Fact]
    public void EndToEnd_Float32_NaNLessOrEqualGreaterOrEqual_AreFalse()
    {
        const string source = """
            package i1616f32op
            import System

            func Main() {
                var nan = float32(System.Single.NaN)
                var one = float32(1.0)
                var two = float32(2.0)
                System.Console.WriteLine(nan <= one)
                System.Console.WriteLine(one <= nan)
                System.Console.WriteLine(nan >= one)
                System.Console.WriteLine(one >= nan)
                System.Console.WriteLine(one <= two)
                System.Console.WriteLine(two >= one)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nFalse\nFalse\nFalse\nTrue\nTrue\n", output);
    }

    [Fact]
    public void EndToEnd_LiftedFloat64Nullable_NaNLessOrEqualGreaterOrEqual_AreFalse()
    {
        const string source = """
            package i1616f64liftop
            import System

            func Main() {
                var nan float64? = System.Double.NaN
                var one float64? = 1.0
                var two float64? = 2.0
                System.Console.WriteLine(nan <= one)
                System.Console.WriteLine(one <= nan)
                System.Console.WriteLine(nan >= one)
                System.Console.WriteLine(one >= nan)
                System.Console.WriteLine(one <= two)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nFalse\nFalse\nFalse\nTrue\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1616nan_exe_").FullName;
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
