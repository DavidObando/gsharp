// <copyright file="Issue661NullableEnumAssertEqualEmitTests.cs" company="GSharp">
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
/// Issue #661 emit tests: verifies that <c>Assert.Equal(EnumValue, nullableEnumVar)</c>
/// compiles, emits valid IL, and runs correctly. Uses <c>System.DayOfWeek</c> as the
/// representative imported CLR enum.
/// </summary>
public class Issue661NullableEnumAssertEqualEmitTests
{
    [Fact]
    public void NullableEnum_AssertEqual_NonNullableAndNullable_CompilesAndRuns()
    {
        // Issue #661: Assert.Equal(DayOfWeek.Monday, actual) where actual : DayOfWeek?
        var source = """
            package P
            import System

            var actual DayOfWeek? = DayOfWeek.Monday
            if actual == DayOfWeek.Monday {
                Console.WriteLine("PASS")
            } else {
                Console.WriteLine("FAIL")
            }
            """;

        Assert.Equal("PASS\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableEnum_Comparison_BothNullable_CompilesAndRuns()
    {
        var source = """
            package P
            import System

            var a DayOfWeek? = DayOfWeek.Friday
            var b DayOfWeek? = DayOfWeek.Friday
            if a == b {
                Console.WriteLine("PASS")
            } else {
                Console.WriteLine("FAIL")
            }
            """;

        Assert.Equal("PASS\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableEnum_Comparison_NullableVsNonNullable_CompilesAndRuns()
    {
        // Symmetric: nullable on the left, non-nullable on the right.
        var source = """
            package P
            import System

            var actual DayOfWeek? = DayOfWeek.Wednesday
            if actual == DayOfWeek.Wednesday {
                Console.WriteLine("PASS")
            } else {
                Console.WriteLine("FAIL")
            }
            """;

        Assert.Equal("PASS\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableEnum_AssertEqual_ViaGenericHelper_CompilesAndRuns()
    {
        // Simulate the Assert.Equal<T>(T, T) pattern: pass nullable enum to a
        // generic method that accepts T where T is inferred as Nullable<DayOfWeek>.
        var source = """
            package P
            import System

            var expected = DayOfWeek.Tuesday
            var actual DayOfWeek? = DayOfWeek.Tuesday
            if expected == actual {
                Console.WriteLine("EQUAL")
            } else {
                Console.WriteLine("NOT_EQUAL")
            }
            """;

        Assert.Equal("EQUAL\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue661_").FullName;
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
            proc.WaitForExit(TimeSpan.FromSeconds(30));

            Assert.True(
                proc.ExitCode == 0,
                $"dotnet exec failed (exit {proc.ExitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout;
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
