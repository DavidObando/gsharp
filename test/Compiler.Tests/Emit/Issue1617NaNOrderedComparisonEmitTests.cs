// <copyright file="Issue1617NaNOrderedComparisonEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1617 (drift 2): the IEEE-754-aware NaN handling for the ordered
/// <c>&lt;=</c> / <c>&gt;=</c> comparisons on <c>float32</c>/<c>float64</c> had
/// reached the relational-pattern emit copy but NOT the two binary-operator
/// emit copies (<c>EmitBinary</c> and the lifted-nullable
/// <c>EmitUnderlyingOrdering</c>). Those copies emitted the signed
/// <c>cgt</c>/<c>clt</c> for <c>&lt;=</c>/<c>&gt;=</c>, which the <c>ldc.i4.0;
/// ceq</c> negation turns into <c>true</c> when an operand is NaN — the wrong
/// answer. The fix routes float <c>&lt;=</c>/<c>&gt;=</c> through the unordered
/// <c>cgt.un</c>/<c>clt.un</c> variants so a NaN operand yields <c>false</c>,
/// matching IEEE-754 and Roslyn.
/// <para>
/// Each test uses a UNIQUE package name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed and not cleared between tests.
/// </para>
/// </summary>
public class Issue1617NaNOrderedComparisonEmitTests
{
    [Fact]
    public void EndToEnd_NaNLessOrEqualGreaterOrEqual_Operators_AreFalse()
    {
        // `nan` is a runtime local (not a compile-time constant) so the
        // comparisons are emitted through EmitBinary rather than folded.
        const string source = """
            package i1617nanop
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nFalse\nFalse\nFalse\nTrue\nTrue\n", output);
    }

    [Fact]
    public void EndToEnd_NaNLessOrEqualGreaterOrEqual_NullableOperators_AreFalse()
    {
        // Nullable float `<=`/`>=` route through the lifted
        // EmitUnderlyingOrdering copy; both operands are non-null here so the
        // result is driven purely by the underlying NaN comparison.
        const string source = """
            package i1617nannullable
            import System

            func Main() {
                var nan float64? = System.Double.NaN
                var one float64? = 1.0
                System.Console.WriteLine(nan <= one)
                System.Console.WriteLine(one <= nan)
                System.Console.WriteLine(nan >= one)
                System.Console.WriteLine(one >= nan)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nFalse\nFalse\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_Float32NaNLessOrEqual_Operator_IsFalse()
    {
        const string source = """
            package i1617nanfloat32
            import System

            func Main() {
                var nan float32 = System.Single.NaN
                var one = float32(1.0)
                var two = float32(2.0)
                System.Console.WriteLine(nan <= one)
                System.Console.WriteLine(one >= nan)
                System.Console.WriteLine(one <= two)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nFalse\nTrue\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1617nan_exe_").FullName;
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
