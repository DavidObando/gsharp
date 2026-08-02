// <copyright file="Issue3010EntryPointExitCodeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3010: integer script results are process exit codes, not displayed values.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3010EntryPointExitCodeTests
{
    public enum ProgramShape
    {
        ExplicitMain,
        TopLevel,
    }

    public static IEnumerable<object[]> IntegerExitCases()
    {
        foreach (var shape in Enum.GetValues<ProgramShape>())
        {
            yield return new object[] { shape, 0, 0 };
            yield return new object[] { shape, 7, 7 };
            yield return new object[] { shape, -1, NormalizeProcessExitCode(-1) };
            yield return new object[] { shape, 256, NormalizeProcessExitCode(256) };
        }
    }

    public static IEnumerable<object[]> FalsePositiveCases()
    {
        foreach (var shape in Enum.GetValues<ProgramShape>())
        {
            yield return new object[] { shape, "void", "void-22\n" };
            yield return new object[] { shape, "trailing-int", "keep-22\n" };
            yield return new object[] { shape, "trailing-string", "keep-22\n" };
            yield return new object[] { shape, "ignored-int-call", "call-22\n" };
        }
    }

    [Theory]
    [MemberData(nameof(IntegerExitCases))]
    public async Task IntegerEntryPointResultMatchesEmittedProgramAsync(
        ProgramShape shape,
        int returnedValue,
        int expectedProcessExitCode)
    {
        var source = shape == ProgramShape.ExplicitMain
            ? $$"""
                import System

                func Main() int32 {
                    Console.WriteLine("{{shape}}-11")
                    return {{returnedValue}}
                }
                """
            : $$"""
                import System

                Console.WriteLine("{{shape}}-11")
                return {{returnedValue}}
                """;

        await AssertDriverMatrixAsync(
            source,
            $"{shape}-11\n",
            expectedProcessExitCode);
    }

    [Theory]
    [MemberData(nameof(FalsePositiveCases))]
    public async Task NonExitValuesRemainDiscardedAsync(
        ProgramShape shape,
        string valueShape,
        string expectedOutput)
    {
        var source = BuildFalsePositiveSource(shape, valueShape);

        await AssertDriverMatrixAsync(source, expectedOutput, expectedProcessExitCode: 0);
    }

    [Fact]
    public async Task ExplicitMainUnsignedIntegerResultBecomesExitCodeAsync()
    {
        const string Source = """
            import System

            func Main() uint32 {
                Console.WriteLine("unsigned-11")
                return 7
            }
            """;

        var result = await RunScriptProcessAsync(Source);

        Assert.Equal(7, result.ExitCode);
        Assert.Equal("unsigned-11\n", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public async Task ExplicitMainIntegerFalloffIsRejectedAsync()
    {
        const string Source = """
            import System

            func Main() int32 {
                Console.WriteLine("must-not-run-11")
            }
            """;

        var result = await RunScriptProcessAsync(Source);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Contains("error GS0100: Not all code paths return a value.", result.StandardError);
    }

    [Fact]
    public async Task ExplicitStringMainIsRejectedBeforeExecutionAsync()
    {
        const string Source = """
            import System

            func Main() string {
                Console.WriteLine("must-not-run-11")
                return "value-33"
            }
            """;

        var result = await RunScriptProcessAsync(Source);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Contains(
            "error GSI001: Evaluation error: Entry point must have a return type of void, int32, or uint32.",
            result.StandardError);
    }

    [Fact]
    public async Task DeclarationOnlyScriptReturnsZeroWithoutOutputAsync()
    {
        var result = await RunScriptProcessAsync("func Helper() { }");

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public async Task ScriptDiagnosticRetainsSourcePathAsync()
    {
        var result = await RunScriptProcessAsync("not valid G# source");

        Assert.Equal(1, result.ExitCode);
        Assert.Contains(result.SourcePath, result.StandardError);
    }

    private static string BuildFalsePositiveSource(ProgramShape shape, string valueShape)
    {
        var body = valueShape switch
        {
            "void" => "    Console.WriteLine(\"void-22\")",
            "trailing-int" => "    Console.WriteLine(\"keep-22\")\n    33",
            "trailing-string" => "    Console.WriteLine(\"keep-22\")\n    \"value-33\"",
            "ignored-int-call" => "    Console.WriteLine(\"call-22\")\n    Compute()",
            _ => throw new ArgumentOutOfRangeException(nameof(valueShape)),
        };
        var helper = valueShape == "ignored-int-call"
            ? """
                func Compute() int32 {
                    return 33
                }

                """
            : string.Empty;

        return shape == ProgramShape.ExplicitMain
            ? $$"""
                import System

                {{helper}}func Main() {
                {{body}}
                }
                """
            : $$"""
                import System

                {{helper}}{{body[4..]}}
                """;
    }

    private static async Task AssertDriverMatrixAsync(
        string source,
        string expectedProgramOutput,
        int expectedProcessExitCode)
    {
        var root = Path.Combine(
            Environment.CurrentDirectory,
            "Issue3010Matrix",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));

        var sourcePath = Path.Combine(root, "program.gs");
        var emitDirectory = Path.Combine(root, "emit");
        Directory.CreateDirectory(emitDirectory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(emitDirectory));
        File.WriteAllText(sourcePath, source);

        var assemblyPath = Path.Combine(
            emitDirectory,
            $"Probe_{Guid.NewGuid():N}.dll");
        var gsc = GetDriverPath("gsc");
        var gsi = GetDriverPath("gsi");

        try
        {
            var evaluated = await RunProcessAsync(gsc, sourcePath);
            Assert.Equal(0, evaluated.ExitCode);
            Assert.Equal(expectedProgramOutput + "Success.\n", evaluated.StandardOutput);
            Assert.Equal(string.Empty, evaluated.StandardError);

            var emitted = await RunProcessAsync(gsc, sourcePath, $"/out:{assemblyPath}");
            Assert.Equal(0, emitted.ExitCode);
            Assert.Equal(string.Empty, emitted.StandardError);
            Assert.True(File.Exists(assemblyPath));
            Assert.NotEmpty(Assembly.Load(File.ReadAllBytes(assemblyPath)).GetTypes());

            var compiled = await RunProcessAsync("dotnet", assemblyPath);
            var interpreted = await RunProcessAsync(gsi, sourcePath);

            Assert.Equal(expectedProcessExitCode, compiled.ExitCode);
            Assert.Equal(expectedProcessExitCode, interpreted.ExitCode);
            Assert.Equal(expectedProgramOutput, compiled.StandardOutput);
            Assert.Equal(compiled.StandardOutput, interpreted.StandardOutput);
            Assert.Equal(string.Empty, compiled.StandardError);
            Assert.Equal(compiled.StandardError, interpreted.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task<ScriptResult> RunScriptProcessAsync(string source)
    {
        var root = Path.Combine(
            Environment.CurrentDirectory,
            "Issue3010",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "program.gs");
        File.WriteAllText(path, source);

        try
        {
            var result = await RunProcessAsync(GetDriverPath("gsi"), path);
            return new ScriptResult(
                result.ExitCode,
                result.StandardOutput,
                result.StandardError,
                path);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string GetDriverPath(string driver)
    {
        var testDirectory = Path.GetDirectoryName(
            typeof(Issue3010EntryPointExitCodeTests).Assembly.Location);
        var executable = Path.GetFullPath(Path.Combine(
            testDirectory,
            driver == "gsi" ? ".." : ".",
            driver == "gsi" ? "Repl" : string.Empty,
            OperatingSystem.IsWindows() ? $"{driver}.exe" : driver));
        Assert.True(File.Exists(executable), $"{driver} executable not found at {executable}.");
        return executable;
    }

    private static async Task<ProcessResult> RunProcessAsync(
        string executable,
        params string[] arguments)
    {
        var startInfo = new ProcessStartInfo(executable)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo);
        Assert.NotNull(process);

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.True(process.WaitForExit(5_000), "Child process did not exit after it was killed.");
            await Task.WhenAll(stdoutTask, stderrTask);
            Assert.Fail($"Process timed out after 30 seconds: {executable}");
        }

        return new ProcessResult(
            process.ExitCode,
            Normalize(await stdoutTask),
            Normalize(await stderrTask));
    }

    private static int NormalizeProcessExitCode(int value)
        => OperatingSystem.IsWindows() ? value : value & 0xff;

    private static string Normalize(string text)
        => text.Replace("\r\n", "\n", StringComparison.Ordinal);

    private sealed record ProcessResult(
        int ExitCode,
        string StandardOutput,
        string StandardError);

    private sealed record ScriptResult(
        int ExitCode,
        string StandardOutput,
        string StandardError,
        string SourcePath);
}
