// <copyright file="Issue1880UnsignedRightShiftEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1880 — G# had no unsigned (logical) right-shift operator, so a
/// translated `>>>`/`>>>=` from C# either crashed cs2gs stage-1 (unknown
/// binary operator) or round-tripped to unparsable G# source. This adds the
/// `>>>` binary operator and `>>>=` compound-assign operator to the G#
/// language itself, emitting CLR `shr.un` regardless of the operand's
/// signedness (unlike `>>`, which emits `shr` for signed operands). Covers
/// int32, uint32, and int64, verifying the result differs from `>>` on a
/// negative operand.
/// </summary>
public class Issue1880UnsignedRightShiftEmitTests
{
    [Fact]
    public void EndToEnd_Int32_UnsignedShiftRight_DiffersFromArithmeticShift()
    {
        const string source = """
            package i1880int32
            import System

            func Main() {
                var negative int32 = -8
                var logical = negative >>> 1
                var arithmetic = negative >> 1
                System.Console.WriteLine(logical)
                System.Console.WriteLine(arithmetic)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"{unchecked((int)((uint)(-8) >> 1))}\n{-8 >> 1}\n", output);
    }

    [Fact]
    public void EndToEnd_Int32_UnsignedShiftRightAssign_MutatesInPlace()
    {
        const string source = """
            package i1880int32compound
            import System

            func Main() {
                var v int32 = -8
                v >>>= 1
                System.Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"{unchecked((int)((uint)(-8) >> 1))}\n", output);
    }

    [Fact]
    public void EndToEnd_UInt32_UnsignedShiftRight_MatchesPlainShift()
    {
        const string source = """
            package i1880uint32
            import System

            func Main() {
                var v uint32 = 4294967288u
                var logical = v >>> 1
                var arithmetic = v >> 1
                System.Console.WriteLine(logical)
                System.Console.WriteLine(arithmetic)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"{4294967288u >> 1}\n{4294967288u >> 1}\n", output);
    }

    [Fact]
    public void EndToEnd_Int64_UnsignedShiftRight_DiffersFromArithmeticShift()
    {
        const string source = """
            package i1880int64
            import System

            func Main() {
                var negative int64 = -8L
                var logical = negative >>> 1
                var arithmetic = negative >> 1
                System.Console.WriteLine(logical)
                System.Console.WriteLine(arithmetic)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"{unchecked((long)((ulong)(-8L) >> 1))}\n{-8L >> 1}\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1880_exe_").FullName;
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
