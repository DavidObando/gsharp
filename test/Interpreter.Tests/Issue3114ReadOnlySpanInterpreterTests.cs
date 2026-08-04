// <copyright file="Issue3114ReadOnlySpanInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issue #3114: shipped Span samples agree across all three drivers.</summary>
[Collection("ConsoleIo")]
public class Issue3114ReadOnlySpanInterpreterTests
{
    public enum Driver
    {
        CompilerEvaluation,
        CompilerEmission,
        Interpreter,
    }

    public static IEnumerable<object[]> SampleDriverCases()
    {
        foreach (var (sample, expected) in new[]
        {
            ("SpanComprehensive.gs", "60\n10\n2\n"),
            ("RefStructGenericField.gs", "3\n"),
            ("SpanIndexing.gs", "60\n402\n"),
        })
        {
            foreach (var driver in Enum.GetValues<Driver>())
            {
                yield return new object[] { sample, expected, driver };
            }
        }
    }

    public static IEnumerable<object[]> Drivers()
    {
        foreach (var driver in Enum.GetValues<Driver>())
        {
            yield return new object[] { driver };
        }
    }

    public static IEnumerable<object[]> InterpretingDrivers()
    {
        yield return new object[] { Driver.CompilerEvaluation };
        yield return new object[] { Driver.Interpreter };
    }

    [Theory]
    [MemberData(nameof(SampleDriverCases))]
    public void ShippedSpanSample_MatchesGoldenAcrossDrivers(string sample, string expected, Driver driver)
    {
        var sourcePath = Path.Combine(LocateSamplesDirectory(), sample);
        var root = Path.Combine(Environment.CurrentDirectory, $".issue3114-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));

        try
        {
            var result = driver switch
            {
                Driver.CompilerEvaluation => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmission => CompileAndRun(root, sample, sourcePath),
                Driver.Interpreter => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEvaluation ? expected + "Success.\n" : expected,
                result.StandardOutput);
            Assert.Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(Drivers))]
    public void SpanConversionMutationAndSlicing_AgreeAcrossDrivers(Driver driver)
    {
        const string Source = """
            import System

            func Main() {
                var values = []int32{11, 22, 33}
                var writable Span[int32] = values
                var readOnly ReadOnlySpan[int32] = writable
                writable[1] = 44
                var tail = readOnly.Slice(1)
                var window = tail.Slice(0, 2)
                var letters = []char{'a', 'b', 'c'}
                var writableChars Span[char] = letters
                var readOnlyChars ReadOnlySpan[char] = writableChars
                Console.WriteLine(readOnly.Length)
                Console.WriteLine(readOnly[1])
                Console.WriteLine(window[1])
                Console.WriteLine(writable.ToString())
                Console.WriteLine(readOnly.ToString())
                Console.WriteLine(window.ToString())
                Console.WriteLine(writableChars.ToString())
                Console.WriteLine(readOnlyChars.ToString())
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3114-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "span-operations.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEvaluation => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmission => CompileAndRun(root, "span-operations.gs", sourcePath),
                Driver.Interpreter => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEvaluation
                    ? "3\n44\n33\nSystem.Span<Int32>[3]\nSystem.ReadOnlySpan<Int32>[3]\nSystem.ReadOnlySpan<Int32>[2]\nabc\nabc\nSuccess.\n"
                    : "3\n44\n33\nSystem.Span<Int32>[3]\nSystem.ReadOnlySpan<Int32>[3]\nSystem.ReadOnlySpan<Int32>[2]\nabc\nabc\n",
                result.StandardOutput);
            Assert.Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    /// <summary>
    /// The evaluator's public-name span interpolation (#3128) now lives only
    /// where the evaluator still runs — the interactive REPL. ADR-0156
    /// Phase 1 moved <c>gsi &lt;file&gt;</c> and bare <c>gsc</c> to emitted
    /// execution, and the emit path cannot lower a span interpolation hole
    /// (#3183), so the driver-level variant of this coverage is
    /// <see cref="SpanInterpolation_ReportsEmitIceOnFileDrivers"/>.
    /// </summary>
    [Fact]
    public void SpanInterpolation_UsesPublicSpanNameInteractively()
    {
        const string Source = """
            import System

            func Main() {
                var values = []int32{11, 22, 33}
                var writable Span[int32] = values
                var readOnly ReadOnlySpan[int32] = writable
                Console.WriteLine("writable=${writable}")
                Console.WriteLine("readonly=${readOnly}")
            }
            """;

        // ByRefLike values cannot be top-level session variables (GS0219), so
        // the interpolation runs inside an entry point, exactly as the file
        // drivers used to evaluate it.
        var cell = new GSharp.Repl.Engine.SessionEngine { CaptureConsole = true, RunEntryPoint = true }.Evaluate(Source);

        Assert.False(cell.HasError);
        Assert.Equal(
            "writable=System.Span<Int32>[3]\nreadonly=System.ReadOnlySpan<Int32>[3]\n",
            cell.Output);
    }

    /// <summary>
    /// #3183: the emit path ICEs on span interpolation holes
    /// (<c>DefaultInterpolatedStringHandler.AppendFormatted[T]</c> rejects
    /// ByRefLike type arguments), which the evaluator masked on the file
    /// drivers until ADR-0156 Phase 1. Until #3183 is fixed, both emitted
    /// file drivers must surface the canonical GS9998 line with exit code 1
    /// instead of crashing; when it is fixed, flip this to assert the
    /// evaluator's golden rendering.
    /// </summary>
    /// <param name="driver">The driver under test.</param>
    [Theory]
    [MemberData(nameof(InterpretingDrivers))]
    public void SpanInterpolation_ReportsEmitIceOnFileDrivers(Driver driver)
    {
        const string Source = """
            import System

            func Main() {
                var values = []int32{11, 22, 33}
                var writable Span[int32] = values
                Console.WriteLine("writable=${writable}")
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3114-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "span-interpolation.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEvaluation => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.Interpreter => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(1, result.ExitCode);
            var diagnosticStream = driver == Driver.CompilerEvaluation
                ? result.StandardOutput
                : result.StandardError;
            Assert.Contains("error GS9998: ArgumentException", diagnosticStream, StringComparison.Ordinal);
            Assert.Contains("AppendFormatted", diagnosticStream, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CompileAndRun(
        string root,
        string sample,
        string sourcePath)
    {
        var outputDirectory = Path.Combine(root, "emit");
        Directory.CreateDirectory(outputDirectory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(outputDirectory));
        var assemblyPath = Path.Combine(outputDirectory, Path.GetFileNameWithoutExtension(sample) + ".dll");
        var compile = CaptureConsole(
            () => GSharp.Compiler.Program.Main(
                ["/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath]));

        Assert.Equal(0, compile.ExitCode);
        Assert.True(File.Exists(assemblyPath), compile.StandardOutput + compile.StandardError);
        Assert.NotEmpty(Assembly.Load(File.ReadAllBytes(assemblyPath)).GetTypes());

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = outputDirectory,
        };
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo);
        Assert.NotNull(process);
        var standardOutput = process.StandardOutput.ReadToEnd();
        var standardError = process.StandardError.ReadToEnd();
        process.WaitForExit();

        return (
            process.ExitCode,
            standardOutput.Replace("\r\n", "\n"),
            standardError.Replace("\r\n", "\n"));
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CaptureConsole(
        Func<int> action)
    {
        using var output = new StringWriter();
        using var error = new StringWriter();
        var previousOutput = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(output);
        Console.SetError(error);
        try
        {
            return (
                action(),
                output.ToString().Replace("\r\n", "\n"),
                error.ToString().Replace("\r\n", "\n"));
        }
        finally
        {
            Console.SetOut(previousOutput);
            Console.SetError(previousError);
        }
    }

    private static string LocateSamplesDirectory()
    {
        var directory = new DirectoryInfo(Environment.CurrentDirectory);
        while (directory != null)
        {
            var samples = Path.Combine(directory.FullName, "samples");
            if (Directory.Exists(samples) && File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                return samples;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate the samples directory.");
    }
}
