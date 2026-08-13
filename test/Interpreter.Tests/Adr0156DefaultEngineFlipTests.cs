// <copyright file="Adr0156DefaultEngineFlipTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using ReplProgram = GSharp.Repl.Program;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0156 Phase 3c (#3176): the emitted submission-chaining engine is the
/// ONLY interactive engine — the tree-walking evaluator and its
/// <c>--engine evaluator</c> / <c>GSI_ENGINE=evaluator</c> escape hatch are
/// deleted. These tests pin the surviving engine-selection surface: 'emit'
/// (and the unset default) is accepted, anything else — including the
/// removed 'evaluator' — is rejected with an error that lists only the
/// valid value.
/// </summary>
public sealed class Adr0156DefaultEngineFlipTests
{
    [Fact]
    public void DefaultAndEmitChoicesAreValid()
    {
        Assert.True(ReplProgram.IsValidEngineChoice(null));
        Assert.True(ReplProgram.IsValidEngineChoice("emit"));
    }

    [Fact]
    public void EvaluatorChoiceIsNoLongerValid()
    {
        Assert.False(ReplProgram.IsValidEngineChoice("evaluator"));
        Assert.Equal("Unknown engine 'evaluator'. Expected 'emit'.", ReplProgram.UnknownEngineMessage("evaluator"));
    }

    [Fact]
    public void BadEngineArgument_FailsWithErrorListingOnlyEmit()
    {
        var (exitCode, _, stderr) = RunMain("--engine", "bogus");

        Assert.Equal(1, exitCode);
        Assert.Contains("Unknown engine 'bogus'. Expected 'emit'.", stderr);
        Assert.DoesNotContain("evaluator", stderr);
    }

    [Fact]
    public void EvaluatorEngineArgument_FailsWithErrorListingOnlyEmit()
    {
        var (exitCode, _, stderr) = RunMain("--engine", "evaluator");

        Assert.Equal(1, exitCode);
        Assert.Contains("Unknown engine 'evaluator'. Expected 'emit'.", stderr);
    }

    [Fact]
    public void EvaluatorEnvironmentVariable_FailsWithErrorListingOnlyEmit()
    {
        var previous = Environment.GetEnvironmentVariable("GSI_ENGINE");
        try
        {
            Environment.SetEnvironmentVariable("GSI_ENGINE", "EVALUATOR");
            Assert.Equal("evaluator", ReplProgram.EngineChoiceFromEnvironment());

            var (exitCode, _, stderr) = RunMain();
            Assert.Equal(1, exitCode);
            Assert.Contains("Unknown engine 'evaluator'. Expected 'emit'.", stderr);
        }
        finally
        {
            Environment.SetEnvironmentVariable("GSI_ENGINE", previous);
        }
    }

    [Fact]
    public void UnsetEnvironmentVariableYieldsDefault()
    {
        var previous = Environment.GetEnvironmentVariable("GSI_ENGINE");
        try
        {
            Environment.SetEnvironmentVariable("GSI_ENGINE", null);
            Assert.Null(ReplProgram.EngineChoiceFromEnvironment());
        }
        finally
        {
            Environment.SetEnvironmentVariable("GSI_ENGINE", previous);
        }
    }

    [Fact]
    public void HelpText_ListsOnlyTheEmitEngine()
    {
        var (exitCode, stdout, _) = RunMain("--help");

        Assert.Equal(0, exitCode);
        Assert.Contains("'emit'", stdout);
        Assert.Contains("engine has been removed", stdout);
        Assert.DoesNotContain("deprecated", stdout);
    }

    [Fact]
    public void WebsiteHelpTranscript_MatchesDriverOutput()
    {
        var (exitCode, stdout, _) = RunMain("--help");
        var documentation = File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "website",
            "docs",
            "tooling",
            "repl.md")).ReplaceLineEndings(Environment.NewLine);
        var opening = $"```text{Environment.NewLine}Usage: gsi ";
        var blockStart = documentation.IndexOf(opening, StringComparison.Ordinal);
        Assert.True(blockStart >= 0, "website/docs/tooling/repl.md has no gsi --help transcript.");
        blockStart += $"```text{Environment.NewLine}".Length;
        var blockEnd = documentation.IndexOf("\n```", blockStart, StringComparison.Ordinal);
        Assert.True(blockEnd >= 0, "gsi --help transcript has no closing code fence.");

        Assert.Equal(0, exitCode);
        Assert.Equal(
            stdout.ReplaceLineEndings(Environment.NewLine).TrimEnd(),
            documentation[blockStart..blockEnd].TrimEnd());
    }

    private static string FindRepoRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory);
             directory is not null;
             directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                return directory.FullName;
            }
        }

        throw new DirectoryNotFoundException("Could not locate GSharp.sln.");
    }

    private static (int ExitCode, string Stdout, string Stderr) RunMain(params string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = ReplProgram.Main(args);
            return (exitCode, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
