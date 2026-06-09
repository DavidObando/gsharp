// <copyright file="Issue6_6EnumLiftedNullableArithmeticEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Bug-overview item 6.6: §6.1 × §11.10 composition — lifted nullable
/// enum arithmetic. Verifies that enum arithmetic operators automatically
/// compose with the lifted-nullable binary arm.
/// </summary>
public class Issue6_6EnumLiftedNullableArithmeticEmitTests
{
    [Fact]
    public void EnumNullable_Plus_UnderlyingNullable_BothPresent()
    {
        var source = """
            package P
            import System

            var a System.DayOfWeek? = DayOfWeek.Monday
            var b int32? = int32(2)
            Console.WriteLine(a + b)
            """;

        Assert.Equal("Wednesday\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumNullable_Plus_UnderlyingNullable_LeftNull()
    {
        var source = """
            package P
            import System

            var a System.DayOfWeek? = nil
            var b int32? = int32(2)
            Console.WriteLine(a + b)
            """;

        Assert.Equal("\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumNullable_Plus_UnderlyingNullable_RightNull()
    {
        var source = """
            package P
            import System

            var a System.DayOfWeek? = DayOfWeek.Monday
            var b int32? = nil
            Console.WriteLine(a + b)
            """;

        Assert.Equal("\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumNullable_Minus_EnumNullable_BothPresent()
    {
        var source = """
            package P
            import System

            var a System.DayOfWeek? = DayOfWeek.Friday
            var b System.DayOfWeek? = DayOfWeek.Monday
            Console.WriteLine(a - b)
            """;

        Assert.Equal("4\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumNullable_Minus_EnumNullable_LeftNull()
    {
        var source = """
            package P
            import System

            var a System.DayOfWeek? = nil
            var b System.DayOfWeek? = DayOfWeek.Monday
            Console.WriteLine(a - b)
            """;

        Assert.Equal("\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumNullable_Minus_UnderlyingNullable_BothPresent()
    {
        var source = """
            package P
            import System

            var a System.DayOfWeek? = DayOfWeek.Friday
            var b int32? = int32(1)
            Console.WriteLine(a - b)
            """;

        Assert.Equal("Thursday\n", CompileAndRun(source));
    }

    [Fact]
    public void UnderlyingNullable_Plus_EnumNullable_BothPresent()
    {
        var source = """
            package P
            import System

            var a int32? = int32(3)
            var b System.DayOfWeek? = DayOfWeek.Monday
            Console.WriteLine(a + b)
            """;

        Assert.Equal("Thursday\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumNullable_Mixed_NonNullable_Underlying()
    {
        var source = """
            package P
            import System

            var a System.DayOfWeek? = DayOfWeek.Monday
            Console.WriteLine(a + int32(4))
            """;

        Assert.Equal("Friday\n", CompileAndRun(source));
    }

    // ── Helpers (same pattern as Issue574 / Issue6_6 arithmetic) ───────

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue6_6_lifted_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

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

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
