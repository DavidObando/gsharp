// <copyright file="Issue1435DecimalConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1435 — explicit conversions FROM <c>decimal</c> to any numeric
/// target. <see cref="decimal"/> declares many <c>op_Explicit(decimal)</c>
/// overloads that differ only by return type, so seeding the operator lookup
/// with <c>Type.GetMethod("op_Explicit", new[] { typeof(decimal) })</c> threw
/// <see cref="System.Reflection.AmbiguousMatchException"/> and surfaced as a
/// GS9998 internal compiler error for EVERY decimal-&gt;numeric conversion.
/// The fix disambiguates the operator by both parameter and return type.
/// These tests compile + run a conversion to each numeric target end-to-end.
/// </summary>
public class Issue1435DecimalConversionEmitTests
{
    [Fact]
    public void EndToEnd_DecimalToAllNumericTargets_Runs()
    {
        var source = """
            package Probe1435a
            import System

            func Main() {
                let d decimal = 42

                Console.WriteLine(int8(d))
                Console.WriteLine(uint8(d))
                Console.WriteLine(int16(d))
                Console.WriteLine(uint16(d))
                Console.WriteLine(int32(d))
                Console.WriteLine(uint32(d))
                Console.WriteLine(int64(d))
                Console.WriteLine(uint64(d))
                Console.WriteLine(float32(d))
                Console.WriteLine(float64(d))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n42\n42\n42\n42\n42\n42\n42\n42\n42\n", output);
    }

    [Fact]
    public void EndToEnd_DecimalToUInt64_FromMethod_Runs()
    {
        var source = """
            package Probe1435b
            import System

            class Holder1435b {
                func ToU64(d decimal) uint64 -> uint64(d)
            }

            func Main() {
                let h = Holder1435b()
                Console.WriteLine(h.ToU64(decimal(123)))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("123\n", output);
    }

    [Fact]
    public void EndToEnd_DecimalToInt32_Truncates_Runs()
    {
        var source = """
            package Probe1435c
            import System

            func Main() {
                let d decimal = 7
                let half decimal = d / decimal(2)
                Console.WriteLine(int32(half))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1435_exe_").FullName;
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
