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
                return 7
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(7, result.ExitCode);
        Assert.Equal($"main{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void TopLevelIntegerResultBecomesExitCode()
    {
        const string Source = """
            import System

            Console.WriteLine("tls")
            return 7
            """;

        var result = RunScript(Source);

        Assert.Equal(7, result.ExitCode);
        Assert.Equal($"tls{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void ExplicitMainIntegerZeroReturnsZero()
    {
        const string Source = """
            import System

            func Main() int32 {
                Console.WriteLine("zero")
                return 0
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"zero{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void ExplicitMainUnsignedIntegerResultBecomesExitCode()
    {
        const string Source = """
            import System

            func Main() uint32 {
                Console.WriteLine("unsigned")
                return 7
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(7, result.ExitCode);
        Assert.Equal($"unsigned{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void ExplicitMainIntegerFalloffIsRejected()
    {
        const string Source = """
            import System

            func Main() int32 {
                Console.WriteLine("must-not-run")
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Contains(
            "error GS0100: Not all code paths return a value.",
            result.StandardError);
    }

    [Fact]
    public void ExplicitVoidMainDiscardsBareIntegerExpression()
    {
        const string Source = """
            import System

            func Main() {
                Console.WriteLine("void-int")
                40 + 2
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"void-int{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void ExplicitVoidMainDiscardsBareStringExpression()
    {
        const string Source = """
            import System

            func Main() {
                Console.WriteLine("void-string")
                "leaked"
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"void-string{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void ExplicitVoidMainDiscardsIgnoredIntegerCall()
    {
        const string Source = """
            import System

            func Compute() int32 {
                return 11
            }

            func Main() {
                Console.WriteLine("void-call-int")
                Compute()
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"void-call-int{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void ExplicitVoidMainDiscardsIgnoredGSharpValueCall()
    {
        const string Source = """
            import System

            struct Marker {
                var N int32
            }

            func Make() Marker {
                return Marker{N: 33}
            }

            func Main() {
                Console.WriteLine("void-call-type")
                Make()
            }
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"void-call-type{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void ExplicitStringMainIsRejectedBeforeExecution()
    {
        const string Source = """
            import System

            func Main() string {
                Console.WriteLine("must-not-run")
                return "invalid"
            }
            """;

        var result = RunScript(Source);

        // ADR-0156 Phase 1: the emitted driver mirrors the CLR host, which
        // rejects an invalid entry-point signature with MethodAccessException
        // before running a single statement.
        Assert.Equal(GSharp.Core.CodeAnalysis.Execution.EmittedProgramHost.UnhandledExceptionExitCode, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Contains(
            "Unhandled exception. System.MethodAccessException: Entry point must have a return type of void, integer, or unsigned integer.",
            result.StandardError);
    }

    [Fact]
    public void ExplicitGSharpValueMainIsRejectedBeforeExecution()
    {
        const string Source = """
            import System

            struct Marker {
                var N int32
            }

            func Main() Marker {
                Console.WriteLine("must-not-run")
                return Marker{N: 33}
            }
            """;

        var result = RunScript(Source);

        // ADR-0156 Phase 1: same CLR-host rejection shape as the string case.
        Assert.Equal(GSharp.Core.CodeAnalysis.Execution.EmittedProgramHost.UnhandledExceptionExitCode, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Contains(
            "Unhandled exception. System.MethodAccessException: Entry point must have a return type of void, integer, or unsigned integer.",
            result.StandardError);
    }

    [Fact]
    public void TopLevelVoidEntryPointDiscardsBareIntegerExpression()
    {
        const string Source = """
            import System

            Console.WriteLine("top-int")
            40 + 2
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"top-int{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void TopLevelVoidEntryPointDiscardsBareStringExpression()
    {
        const string Source = """
            import System

            Console.WriteLine("top-string")
            "leaked"
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"top-string{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void TopLevelVoidEntryPointDiscardsIgnoredIntegerCall()
    {
        const string Source = """
            import System

            func Compute() int32 {
                return 22
            }

            Console.WriteLine("top-call-int")
            Compute()
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"top-call-int{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void TopLevelNoResultReturnsZero()
    {
        const string Source = """
            import System

            Console.WriteLine("top-no-result")
            """;

        var result = RunScript(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"top-no-result{Environment.NewLine}", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    [Fact]
    public void DeclarationOnlyScriptReturnsZeroWithoutOutput()
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
                output.ToString().ReplaceLineEndings(Environment.NewLine),
                error.ToString().ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            Console.SetOut(previousOutput);
            Console.SetError(previousError);
            File.Delete(path);
        }
    }
}
