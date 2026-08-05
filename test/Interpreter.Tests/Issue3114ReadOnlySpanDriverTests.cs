// <copyright file="Issue3114ReadOnlySpanDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Driver coverage for issue #3114 read-only span samples; every driver path uses emitted execution.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3114ReadOnlySpanDriverTests
{
    public enum Driver
    {
        CompilerEmitToMemory,
        CompilerEmitToFile,
        ReplEmitToMemory,
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
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileAndRun(root, sample, sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEmitToMemory ? expected + "Success.\n" : expected,
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
                var letters = []char{'a', 'b', 'c', 'd', 'e'}
                var writableChars Span[char] = letters
                var readOnlyChars ReadOnlySpan[char] = writableChars
                var charWindow = readOnlyChars.Slice(1, 3)
                Console.WriteLine(readOnly.Length)
                Console.WriteLine(readOnly[1])
                Console.WriteLine(window[1])
                Console.WriteLine(writable.ToString())
                Console.WriteLine(readOnly.ToString())
                Console.WriteLine(window.ToString())
                Console.WriteLine(writableChars.ToString())
                Console.WriteLine(readOnlyChars.ToString())
                Console.WriteLine(charWindow.ToString())
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3114-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "span-operations.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var emitted = CompileAndRun(root, "span-operations.gs", sourcePath);
            Assert.Equal(
                "3\n44\n33\nSystem.Span<Int32>[3]\nSystem.ReadOnlySpan<Int32>[3]\nSystem.ReadOnlySpan<Int32>[2]\nabcde\nabcde\nbcd\n",
                emitted.StandardOutput);

            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => emitted,
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEmitToMemory
                    ? emitted.StandardOutput + "Success.\n"
                    : emitted.StandardOutput,
                result.StandardOutput);
            Assert.Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    /// <summary>
    /// #3183: emitted interpolation routes ByRefLike holes through their CLR
    /// <c>ToString()</c> method instead of closing generic
    /// <c>AppendFormatted&lt;T&gt;</c> over an unsupported type argument.
    /// </summary>
    /// <param name="driver">The driver under test.</param>
    [Theory]
    [MemberData(nameof(Drivers))]
    public void SpanInterpolation_RendersAcrossFileDrivers(Driver driver)
    {
        const string Source = """
            import System

            func Main() {
                var values = []int32{11, 22, 33}
                var writable Span[int32] = values
                var readOnly ReadOnlySpan[int32] = writable
                var letters = []char{'h', 'e', 'l', 'l', 'o'}
                var writableChars Span[char] = letters
                var readOnlyChars ReadOnlySpan[char] = writableChars
                Console.WriteLine("writable=${writable}")
                Console.WriteLine("readonly=${readOnly}")
                Console.WriteLine("writableChars=${writableChars}")
                Console.WriteLine("chars=${readOnlyChars}")
                Console.WriteLine("aligned=${readOnlyChars,8}")
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
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileAndRun(root, "span-interpolation.gs", sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEmitToMemory
                    ? "writable=System.Span<Int32>[3]\nreadonly=System.ReadOnlySpan<Int32>[3]\nwritableChars=hello\nchars=hello\naligned=   hello\nSuccess.\n"
                    : "writable=System.Span<Int32>[3]\nreadonly=System.ReadOnlySpan<Int32>[3]\nwritableChars=hello\nchars=hello\naligned=   hello\n",
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
    public void OrdinaryInterpolation_RemainsUnchangedAcrossFileDrivers(Driver driver)
    {
        const string Source = """
            import System

            func Main() {
                var value = 42
                Console.WriteLine("value=${value}")
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3183-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "ordinary-interpolation.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileAndRun(root, "ordinary-interpolation.gs", sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEmitToMemory
                    ? "value=42\nSuccess.\n"
                    : "value=42\n",
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
    public void UserRefStructInterpolation_ReportsFallbackDiagnosticAcrossFileDrivers(Driver driver)
    {
        const string Source = """
            ref struct Token {
                var value int32
            }

            func Main() {
                var token Token = Token{value: 42}
                Console.WriteLine("token=${token}")
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3183-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "user-ref-struct-interpolation.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileOnly(root, "user-ref-struct-interpolation.gs", sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(1, result.ExitCode);
            var diagnosticStream = driver == Driver.ReplEmitToMemory
                ? result.StandardError
                : result.StandardOutput;
            Assert.Equal(
                driver == Driver.ReplEmitToMemory ? string.Empty : "Failed.\n",
                driver == Driver.ReplEmitToMemory ? result.StandardOutput : result.StandardError);

            var diagnostic = Assert.Single(
                diagnosticStream.Split('\n', StringSplitOptions.RemoveEmptyEntries),
                line => line.Contains("error GS0519:", StringComparison.Ordinal));
            AssertByRefLikeInterpolationDiagnostic(diagnostic, sourcePath, 7, "Token");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertByRefLikeInterpolationDiagnostic(
        string line,
        string sourcePath,
        int startLine,
        string typeName)
    {
        Assert.StartsWith($"{sourcePath}({startLine},", line, StringComparison.Ordinal);
        Assert.Contains(": error GS0519:", line, StringComparison.Ordinal);
        Assert.Contains(typeName, line, StringComparison.Ordinal);
        Assert.Contains("has no available CLR ToString method", line, StringComparison.Ordinal);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CompileOnly(
        string root,
        string sample,
        string sourcePath)
    {
        var outputDirectory = Path.Combine(root, "emit");
        Directory.CreateDirectory(outputDirectory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(outputDirectory));
        var assemblyPath = Path.Combine(outputDirectory, Path.GetFileNameWithoutExtension(sample) + ".dll");
        return CaptureConsole(
            () => GSharp.Compiler.Program.Main(
                ["/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath]));
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
