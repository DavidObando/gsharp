// <copyright file="Issue3010EntryPointExitCodeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3010: integer script results are process exit codes, not displayed values.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3010EntryPointExitCodeTests
{
    [Fact]
    public void ExplicitMainIntegerResultBecomesExitCode()
    {
        const string Source = """
            import System

            func Main() int32 {
                Console.WriteLine("main")
                return 3
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(3, result.ExitCode);
        Assert.Equal("main\n", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void TopLevelIntegerResultBecomesExitCode()
    {
        const string Source = """
            import System

            Console.WriteLine("tls")
            return 3
            """;

        var result = RunScript(Source);

        Assert.Equal(3, result.ExitCode);
        Assert.Equal("tls\n", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void NonIntegerResultIsStillPrinted()
    {
        var result = RunScript("\"text-result\"");

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("text-result\n", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void NoResultStillReturnsZeroWithoutOutput()
    {
        var result = RunScript("func Helper() { }");

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) RunScript(string source)
    {
        var path = Path.Combine(Environment.CurrentDirectory, $".issue3010-{Guid.NewGuid():N}.gs");
        File.WriteAllText(path, source);

        using var output = new StringWriter();
        using var error = new StringWriter();
        var previousOutput = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(output);
        Console.SetError(error);
        try
        {
            var exitCode = GSharp.Repl.Program.Main(new[] { path });
            return (
                exitCode,
                output.ToString().Replace("\r\n", "\n"),
                error.ToString().Replace("\r\n", "\n"));
        }
        finally
        {
            Console.SetOut(previousOutput);
            Console.SetError(previousError);
            File.Delete(path);
        }
    }
}
