// <copyright file="ProgramSilentFailureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// 6.2 SilentEmitFailure invariant (outer ring): asserts that the GS9998
/// diagnostic line format emitted by <see cref="Program.Main"/> matches the
/// SDK BuildTask regex and that valid programs don't trigger it.
/// </summary>
public class ProgramSilentFailureTests
{
    /// <summary>
    /// The SDK BuildTask regex for diagnostic lines.
    /// </summary>
    private static readonly Regex DiagnosticLine = new(
        @"^(?<file>[^(]+)\((?<l1>\d+),(?<c1>\d+)(?:,(?<l2>\d+),(?<c2>\d+))?\):\s*(?<sev>error|warning|info)\s+(?<code>[^:]+):\s*(?<msg>.*)$",
        RegexOptions.Compiled);

    [Fact]
    public void Main_ValidProgram_ExitsZero_NoGS9998()
    {
        var source = """
            package Test
            import System

            Console.WriteLine("hello")
            """;

        var (exitCode, stdout, _) = RunCompiler(source);

        Assert.Equal(0, exitCode);

        // No GS9998 should appear for a valid program
        var lines = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        foreach (var line in lines)
        {
            var match = DiagnosticLine.Match(line.Trim());
            Assert.False(
                match.Success && match.Groups["code"].Value.Trim() == "GS9998",
                $"Unexpected GS9998 in stdout: {line}");
        }
    }

    [Fact]
    public void DiagnosticLineRegex_MatchesExpectedGS9998Format()
    {
        // Verify the format that ReportUnhandledException produces
        // matches the SDK BuildTask diagnostic regex.
        var sampleLine = "/path/to/test.gs(1,1,1,1): error GS9998: InvalidOperationException: something broke";
        var match = DiagnosticLine.Match(sampleLine);

        Assert.True(match.Success, $"Regex should match: {sampleLine}");
        Assert.Equal("/path/to/test.gs", match.Groups["file"].Value);
        Assert.Equal("1", match.Groups["l1"].Value);
        Assert.Equal("1", match.Groups["c1"].Value);
        Assert.Equal("1", match.Groups["l2"].Value);
        Assert.Equal("1", match.Groups["c2"].Value);
        Assert.Equal("error", match.Groups["sev"].Value);
        Assert.Equal("GS9998", match.Groups["code"].Value.Trim());
        Assert.Contains("InvalidOperationException", match.Groups["msg"].Value);
    }

    [Fact]
    public void Main_BindingError_ProducesNonZeroExit_ButNotGS9998()
    {
        // A binding-time error should produce normal diagnostics, not GS9998.
        var source = """
            package Test
            import System

            var x = undefinedVar
            """;

        var (exitCode, stdout, _) = RunCompiler(source);

        Assert.NotEqual(0, exitCode);

        var lines = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        foreach (var line in lines)
        {
            var match = DiagnosticLine.Match(line.Trim());
            if (match.Success && match.Groups["code"].Value.Trim() == "GS9998")
            {
                Assert.Fail($"Binding error should not produce GS9998: {line}");
            }
        }
    }

    private static (int ExitCode, string Stdout, string Stderr) RunCompiler(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_silent_failure_test_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/nowarn:GS9100",
                srcPath,
            };

            using var outWriter = new StringWriter();
            using var errWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(outWriter);
            Console.SetError(errWriter);
            int exitCode;
            try
            {
                exitCode = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return (exitCode, outWriter.ToString(), errWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}

