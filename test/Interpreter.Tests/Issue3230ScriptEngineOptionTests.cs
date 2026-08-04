// <copyright file="Issue3230ScriptEngineOptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3230: script mode must honor an explicit engine choice.
/// </summary>
[Collection("ConsoleIo")]
public sealed class Issue3230ScriptEngineOptionTests
{
    [Fact]
    public void EvaluatorEngineOptionRunsScriptWithTreeWalkingEvaluator()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3230ScriptEngineOptionTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var scriptPath = Path.Combine(directory, "boundary.gs");
        File.WriteAllText(
            scriptPath,
            """
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            Console.WriteLine("emitted-only-11")
            """);

        try
        {
            var result = Capture(() => GSharp.Repl.Program.Main(["--engine", "evaluator", scriptPath]));

            Assert.Equal(1, result.ExitCode);
            Assert.Equal(string.Empty, result.StandardOutput);
            Assert.Contains("error GS0514:", result.StandardError, StringComparison.Ordinal);
            Assert.Contains("NativeStrLen", result.StandardError, StringComparison.Ordinal);
            Assert.DoesNotContain("emitted-only-11", result.StandardError, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void HelpStatesEngineOptionAppliesToScriptsAndInteractiveSessions()
    {
        var result = Capture(() => GSharp.Repl.Program.Main(["--help"]));

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("Script and interactive engine", result.StandardOutput, StringComparison.Ordinal);
        Assert.Equal(string.Empty, result.StandardError);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) Capture(Func<int> action)
    {
        using var stdout = new StringWriter { NewLine = "\n" };
        using var stderr = new StringWriter { NewLine = "\n" };
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            var exitCode = action();
            return (exitCode, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
