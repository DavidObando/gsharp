// <copyright file="Issue3347TriageEmittedLineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3347: a compile-error triage artifact must quote the EMITTED G# line
/// the diagnostic points at, and must say so plainly when it cannot.
/// <para>
/// Working through the oahu gate, every failing app reported the diagnostic
/// MESSAGE in the "Offending line" field and left "Emitted G#" blank — because
/// the file lookup returned null and <c>CompileError</c> silently substituted
/// <c>diagnostic.Message</c>. Indistinguishable from a real source line to
/// anyone reading the report, and it made four CI round-trips necessary to find
/// what one local run would have shown.
/// </para>
/// </summary>
public class Issue3347TriageEmittedLineTests
{
    private const string GsSource = "func F() {\n    let x = broken(\n}\n";

    private static TriageBuilder NewBuilder() =>
        new TriageBuilder("run_1", "2026-08-11T00:00:00Z", "0.3.0+abc", "src/App/App.csproj");

    /// <summary>
    /// The resolved case: the artifact quotes the emitted line, not the message.
    /// </summary>
    [Fact]
    public void ResolvedFile_QuotesTheEmittedLine()
    {
        var emitted = new EmittedGsFile(
            "/abs/migrated/src/App/Program.gs", "src_App/Program.gs", "/abs/src/App/Program.cs", GsSource);
        var diagnostic = new GscDiagnostic(
            "GS0100", "some diagnostic text", "error", "/abs/migrated/src/App/Program.gs", 2, 13);

        TriageArtifact artifact = NewBuilder().CompileError(diagnostic, emitted);

        Assert.Contains("let x = broken(", artifact.OffendingCSharpConstruct.Snippet, StringComparison.Ordinal);
        Assert.DoesNotContain("some diagnostic text", artifact.OffendingCSharpConstruct.Snippet, StringComparison.Ordinal);
        Assert.Equal("src_App/Program.gs", artifact.SourceLocation.GsFile);
    }

    /// <summary>
    /// The unresolved case must be self-describing rather than silently
    /// substituting the diagnostic message.
    /// </summary>
    [Fact]
    public void UnresolvedFile_SaysSo_RatherThanQuotingTheMessage()
    {
        var diagnostic = new GscDiagnostic(
            "GS0100", "some diagnostic text", "error", "/abs/migrated/src/App/Program.gs", 2, 13);

        TriageArtifact artifact = NewBuilder().CompileError(diagnostic, file: null);

        Assert.Contains(
            "emitted G# line unavailable",
            artifact.OffendingCSharpConstruct.Snippet,
            StringComparison.Ordinal);
        Assert.DoesNotContain("some diagnostic text", artifact.OffendingCSharpConstruct.Snippet, StringComparison.Ordinal);
    }

    /// <summary>
    /// The <c>--via-sdk</c> path routes gsc through MSBuild, which may report a
    /// path relative to the project directory. Resolving that against cs2gs's
    /// working directory does not match, so the matcher compares path suffixes.
    /// </summary>
    [Fact]
    public void ProjectRelativeDiagnosticPath_Resolves()
    {
        var emitted = new EmittedGsFile(
            "/abs/migrated/src/App/Auxiliary/Helper.gs",
            "src_App/Auxiliary/Helper.gs",
            "/abs/src/App/Auxiliary/Helper.cs",
            GsSource);

        EmittedGsFile match = CompileStage.MatchEmittedFile(
            new[] { emitted }, "Auxiliary/Helper.gs");

        Assert.Same(emitted, match);
    }

    /// <summary>
    /// An absolute path from a direct gsc invocation resolves exactly.
    /// </summary>
    [Fact]
    public void AbsoluteDiagnosticPath_Resolves()
    {
        var emitted = new EmittedGsFile(
            "/abs/migrated/src/App/Program.gs", "src_App/Program.gs", "/abs/src/App/Program.cs", GsSource);

        EmittedGsFile match = CompileStage.MatchEmittedFile(
            new[] { emitted }, "/abs/migrated/src/App/Program.gs");

        Assert.Same(emitted, match);
    }

    /// <summary>
    /// A basename shared with a referenced sibling project used to make the
    /// lookup ambiguous and return null, which silently degraded the whole
    /// artifact. The app's own file wins.
    /// </summary>
    [Fact]
    public void BasenameCollidingWithSibling_PrefersTheAppsOwnFile()
    {
        var own = new EmittedGsFile(
            "/abs/migrated/src/App/Extensions.gs", "src_App/Extensions.gs", "/abs/a.cs", GsSource);
        var sibling = new EmittedGsFile(
            "/abs/migrated/src/Other/Extensions.gs", "src_Other/Extensions.gs", "/abs/b.cs", GsSource)
        {
            IsFromReferencedProject = true,
        };

        EmittedGsFile match = CompileStage.MatchEmittedFile(new[] { sibling, own }, "Extensions.gs");

        Assert.Same(own, match);
    }

    /// <summary>
    /// A genuinely ambiguous basename — two of the app's OWN files — stays
    /// unresolved rather than guessing, which the explicit marker then reports.
    /// </summary>
    [Fact]
    public void AmbiguousBasenameAcrossOwnFiles_StaysUnresolved()
    {
        var first = new EmittedGsFile("/abs/a/Shared.gs", "app/a/Shared.gs", "/abs/a.cs", GsSource);
        var second = new EmittedGsFile("/abs/b/Shared.gs", "app/b/Shared.gs", "/abs/b.cs", GsSource);

        Assert.Null(CompileStage.MatchEmittedFile(new[] { first, second }, "Shared.gs"));
    }
}
