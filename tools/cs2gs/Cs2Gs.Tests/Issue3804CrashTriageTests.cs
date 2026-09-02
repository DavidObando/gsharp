// <copyright file="Issue3804CrashTriageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3804, second half: a crash must be REPORTED as a crash. The
/// translate-stage <see cref="IndexOutOfRangeException"/> that walled
/// `test/Interpreter.Tests` off from the self-migration corpus reached the gate
/// as <c>category: "translation-unsupported"</c> under a suggested issue titled
/// <i>"Unsupported C# construct 'IndexOutOfRangeException' has no canonical G#
/// form"</i> — with no file, no line, and no construct. An
/// <see cref="IndexOutOfRangeException"/> is not a C# construct, and a report
/// that says it is reads as already-triaged; that is how the crash sat
/// unexamined for weeks.
/// </summary>
public class Issue3804CrashTriageTests
{
    [Fact]
    public void AStageCrash_IsCategorisedAsACrash_NotAsAnUnsupportedConstruct()
    {
        var builder = new TriageBuilder("run_1", "2026-09-01T00:00:00Z", "0.4.0+abc", "test/Interpreter.Tests");

        TriageArtifact artifact = builder.StageCrash(
            MigrationStageKind.Translate,
            TriageCategory.PipelineCrash,
            "PipelineException",
            new IndexOutOfRangeException("Index was outside the bounds of the array."));

        Assert.Equal("pipeline-crash", artifact.Category);
        Assert.Equal("translate", artifact.Stage);

        // The headline must say what happened. The old rendering put the
        // exception type in the "unsupported construct" slot.
        Assert.DoesNotContain("Unsupported C# construct", artifact.SuggestedIssue.Title, StringComparison.Ordinal);
        Assert.Contains("translate stage crashed", artifact.SuggestedIssue.Title, StringComparison.Ordinal);
        Assert.Contains("IndexOutOfRangeException", artifact.SuggestedIssue.Title, StringComparison.Ordinal);
        Assert.Contains("DEFECT IN THE MIGRATION TOOL", artifact.SuggestedIssue.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void ACrashArtifact_NamesTheFileTheStageWasOn()
    {
        var builder = new TriageBuilder("run_1", "2026-09-01T00:00:00Z", "0.4.0+abc", "test/Interpreter.Tests");

        TriageArtifact artifact = builder.StageCrash(
            MigrationStageKind.Translate,
            TriageCategory.PipelineCrash,
            "PipelineException",
            new IndexOutOfRangeException("Index was outside the bounds of the array."),
            "test/Interpreter.Tests/HighlightTests.cs");

        Assert.Equal("test/Interpreter.Tests/HighlightTests.cs", artifact.SourceLocation.CsFile);
        Assert.Contains(
            "test/Interpreter.Tests/HighlightTests.cs",
            artifact.SuggestedIssue.Body,
            StringComparison.Ordinal);

        // Positions stay null — the annotation names a file, it does not claim
        // a position the stage never had.
        Assert.Null(artifact.SourceLocation.CsLine);
        Assert.Null(artifact.SourceLocation.GsFile);
    }

    [Fact]
    public void TheFileAnnotation_DoesNotDisturbTheCrashFingerprint()
    {
        // Issue #1750's dedup property must survive #3804: the file path is a
        // run-scoped absolute path on a real run, so folding it into the
        // fingerprint would file a fresh issue for the same crash every run.
        var builder = new TriageBuilder("run_1", "2026-09-01T00:00:00Z", "0.4.0+abc", "test/Interpreter.Tests");
        var crash = new IndexOutOfRangeException("Index was outside the bounds of the array.");

        TriageArtifact withoutFile = builder.StageCrash(
            MigrationStageKind.Translate, TriageCategory.PipelineCrash, "PipelineException", crash);
        TriageArtifact withFile = builder.StageCrash(
            MigrationStageKind.Translate,
            TriageCategory.PipelineCrash,
            "PipelineException",
            crash,
            "/tmp/run-9f8e/test/Interpreter.Tests/HighlightTests.cs");

        Assert.Equal(withoutFile.Fingerprint, withFile.Fingerprint);
    }

    [Fact]
    public void TheCrashWrapper_KeepsTheThrownExceptionIntact()
    {
        // TranslationCrashException annotates; it must not become the crash.
        // The pipeline reports the INNER exception, so the construct kind (and
        // therefore the fingerprint) is the same with or without the wrapper.
        var inner = new IndexOutOfRangeException("Index was outside the bounds of the array.");
        var wrapper = new TranslationCrashException("/repo/test/Interpreter.Tests/HighlightTests.cs", inner);

        Assert.Same(inner, wrapper.InnerException);
        Assert.Equal("/repo/test/Interpreter.Tests/HighlightTests.cs", wrapper.SourceFilePath);
        Assert.Contains("HighlightTests.cs", wrapper.Message, StringComparison.Ordinal);
        Assert.Contains(inner.Message, wrapper.Message, StringComparison.Ordinal);
    }
}
