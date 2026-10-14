// <copyright file="Adr0156DefaultEngineFlipTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Tests
import ReplProgram = GSharp.Repl.Program
import System
import System.IO
import Xunit

/// ADR-0156 Phase 3c (#3176): the emitted submission-chaining engine is the
/// ONLY interactive engine — the tree-walking evaluator and its
/// `--engine evaluator` / `GSI_ENGINE=evaluator` escape hatch are
/// deleted. These tests pin the surviving engine-selection surface: 'emit'
/// (and the unset default) is accepted, anything else — including the
/// removed 'evaluator' — is rejected with an error that lists only the
/// valid value.
class Adr0156DefaultEngineFlipTests {
    @Fact
    func DefaultAndEmitChoicesAreValid() {
        Assert.True(ReplProgram.IsValidEngineChoice(nil))
        Assert.True(ReplProgram.IsValidEngineChoice("emit"))
    }

    @Fact
    func EvaluatorChoiceIsNoLongerValid() {
        Assert.False(ReplProgram.IsValidEngineChoice("evaluator"))
        Assert.Equal("Unknown engine 'evaluator'. Expected 'emit'.", ReplProgram.UnknownEngineMessage("evaluator"))
    }

    @Fact
    func BadEngineArgument_FailsWithErrorListingOnlyEmit() {
        let (exitCode, _, stderr) = RunMain("--engine", "bogus")
        Assert.Equal(1, exitCode)
        Assert.Contains("Unknown engine 'bogus'. Expected 'emit'.", stderr)
        Assert.DoesNotContain("evaluator", stderr)
    }

    @Fact
    func EvaluatorEngineArgument_FailsWithErrorListingOnlyEmit() {
        let (exitCode, _, stderr) = RunMain("--engine", "evaluator")
        Assert.Equal(1, exitCode)
        Assert.Contains("Unknown engine 'evaluator'. Expected 'emit'.", stderr)
    }

    @Fact
    func EvaluatorEnvironmentVariable_FailsWithErrorListingOnlyEmit() {
        let previous string? = Environment.GetEnvironmentVariable("GSI_ENGINE")
        try {
            Environment.SetEnvironmentVariable("GSI_ENGINE", "EVALUATOR")
            Assert.Equal("evaluator", ReplProgram.EngineChoiceFromEnvironment())
            let (exitCode, _, stderr) = RunMain()
            Assert.Equal(1, exitCode)
            Assert.Contains("Unknown engine 'evaluator'. Expected 'emit'.", stderr)
        } finally {
            Environment.SetEnvironmentVariable("GSI_ENGINE", previous)
        }
    }

    @Fact
    func UnsetEnvironmentVariableYieldsDefault() {
        let previous string? = Environment.GetEnvironmentVariable("GSI_ENGINE")
        try {
            Environment.SetEnvironmentVariable("GSI_ENGINE", nil)
            Assert.Null(ReplProgram.EngineChoiceFromEnvironment())
        } finally {
            Environment.SetEnvironmentVariable("GSI_ENGINE", previous)
        }
    }

    @Fact
    func HelpText_ListsOnlyTheEmitEngine() {
        let (exitCode, stdout, _) = RunMain("--help")
        Assert.Equal(0, exitCode)
        Assert.Contains("'emit'", stdout)
        Assert.Contains("engine has been removed", stdout)
        Assert.DoesNotContain("deprecated", stdout)
    }

    @Fact
    func WebsiteHelpTranscript_MatchesDriverOutput() {
        let (exitCode, stdout, _) = RunMain("--help")
        let documentation = File.ReadAllText(Path.Combine(FindRepoRoot(), "website", "docs", "tooling", "repl.md"))
            .ReplaceLineEndings(Environment.NewLine)
        let opening = "```text${Environment.NewLine}Usage: gsi "
        var blockStart = documentation.IndexOf(opening, StringComparison.Ordinal)
        Assert.True(blockStart >= 0, "website/docs/tooling/repl.md has no gsi --help transcript.")
        blockStart += "```text${Environment.NewLine}".Length
        let blockEnd = documentation.IndexOf("\n```", blockStart, StringComparison.Ordinal)
        Assert.True(blockEnd >= 0, "gsi --help transcript has no closing code fence.")
        Assert.Equal(0, exitCode)
        Assert.Equal(
            stdout.ReplaceLineEndings(Environment.NewLine).TrimEnd(),
            documentation[blockStart .. blockEnd].TrimEnd()
        )
    }

    shared {
        private func FindRepoRoot() string {
            for var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory);
                directory != nil;
                directory = directory!!.Parent {
                if RepositoryRootMarker.IsRoot(directory.FullName) {
                    return directory.FullName
                }
            }
            throw DirectoryNotFoundException("Could not locate GSharp.sln or GSharp.slnx.")
        }

        private func RunMain(args ...string)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = ReplProgram.Main(args)
                return (exitCode, stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
