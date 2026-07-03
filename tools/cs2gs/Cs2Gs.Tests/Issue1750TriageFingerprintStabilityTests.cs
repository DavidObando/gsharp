// <copyright file="Issue1750TriageFingerprintStabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1750: triage fingerprints must be stable
/// across runs/machines for the same underlying gap. Covers all three
/// reported leaks: (1) crash artifacts embedding run-scoped absolute paths
/// from <see cref="Exception.Message"/>, (2) snippets truncated before shape
/// normalization instead of after, and (3) construct-kind classification
/// matching keyword text anywhere in a line (including inside string
/// literals) instead of the line's leading (structural) token.
/// </summary>
public class Issue1750TriageFingerprintStabilityTests
{
    /// <summary>
    /// (1) A stage crash fingerprints identically across two "runs" whose
    /// exception messages differ only in their embedded run-scoped absolute
    /// paths (a different hex run id and a different absolute root each
    /// time, one Unix-style and one Windows-style) — the same recurring
    /// defect must dedup into one issue instead of filing a fresh one every
    /// run/machine.
    /// </summary>
    [Fact]
    public void StageCrash_SamePathVaryingRuns_ProducesIdenticalFingerprint()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");

        var exUnixRun1 = new InvalidOperationException(
            "Could not find file '/var/folders/T/cs2gsrun-0a1b2c3d4e/App/Program.cs' during stage 2.");
        var exUnixRun2 = new InvalidOperationException(
            "Could not find file '/tmp/cs2gsrun-9f8e7d6c5b4a3210/App/Program.cs' during stage 2.");
        var exWindowsRun = new InvalidOperationException(
            "Could not find file 'C:\\Users\\ci\\AppData\\Local\\Temp\\cs2gsrun-abc123\\App\\Program.cs' during stage 2.");

        TriageArtifact a = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exUnixRun1);
        TriageArtifact b = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exUnixRun2);
        TriageArtifact c = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exWindowsRun);

        Assert.Equal(a.Fingerprint, b.Fingerprint);
        Assert.Equal(a.Fingerprint, c.Fingerprint);
        Assert.StartsWith("sha256:", a.Fingerprint, StringComparison.Ordinal);

        // The construct kind anchors on the deterministic exception type, not
        // free-text pulled from the message.
        Assert.Equal(nameof(InvalidOperationException), a.OffendingCSharpConstruct.Kind);

        // A genuinely different exception type for the same stage must still
        // split into its own fingerprint (it is a different underlying gap).
        TriageArtifact d = builder.StageCrash(
            MigrationStageKind.Compile,
            TriageCategory.CompileError,
            "GS9999",
            new NullReferenceException("Object reference not set to an instance of an object."));
        Assert.NotEqual(a.Fingerprint, d.Fingerprint);
    }

    /// <summary>
    /// (1, generalized) <see cref="Fingerprint.NormalizeShape"/> neutralizes
    /// any absolute path under any root — not just one hardcoded prefix — for
    /// both Unix and Windows/UNC-style paths.
    /// </summary>
    [Fact]
    public void NormalizeShape_NeutralizesAnyAbsolutePath_RegardlessOfRoot()
    {
        Assert.Equal(
            Fingerprint.NormalizeShape("failed at 'lit'"),
            Fingerprint.NormalizeShape("failed at '/var/folders/T/cs2gsrun-0a1b2c/App/Program.cs'"));
        Assert.Equal(
            Fingerprint.NormalizeShape("failed at 'lit'"),
            Fingerprint.NormalizeShape("failed at 'C:\\Users\\ci\\Temp\\cs2gsrun-9f9f\\App\\Program.cs'"));
        Assert.Equal(
            Fingerprint.NormalizeShape("failed at 'lit'"),
            Fingerprint.NormalizeShape("failed at '\\\\build-host\\share\\cs2gsrun-42\\App\\Program.cs'"));
    }

    /// <summary>
    /// (2) A snippet longer than the truncation cap whose head is identical
    /// except for pre-normalization noise (here: two differently-sized string
    /// literal and identifier runs that push the rest of the snippet to
    /// different absolute offsets) must still normalize to the exact same
    /// shape and fingerprint — the truncation boundary must be computed on
    /// already-normalized text, not on the raw snippet.
    /// </summary>
    [Fact]
    public void Fingerprint_NormalizesBeforeTruncating_SoLongSnippetsWithDifferentNoiseDedup()
    {
        // Same construct — `let a = f(<identifier>) + 1;` — but the
        // identifier bound inside f(...) has a very different length, so a
        // naive "truncate raw text at N chars, then normalize" pipeline would
        // cut one snippet mid-argument (dropping the closing paren and the
        // "+ 1;" tail) and the other past the closing paren (keeping it),
        // producing two different shapes for what is structurally the same
        // gap.
        string snippetA = "let a = f(" + new string('x', 155) + ") + 1;";
        string snippetB = "let a = f(" + new string('x', 145) + ") + 1;";
        Assert.True(snippetA.Length > 160 || snippetB.Length > 160, "test setup must exceed the truncation cap");

        string fingerprintA = Fingerprint.Compute("compile-error", "compile", "GS0100", "GSharpConstruct", snippetA);
        string fingerprintB = Fingerprint.Compute("compile-error", "compile", "GS0100", "GSharpConstruct", snippetB);

        Assert.Equal(fingerprintA, fingerprintB);

        // And the normalized shape is exactly what normalize-then-truncate
        // predicts: the identifier is fully collapsed before any cap applies.
        Assert.Equal("id id = id(id) + lit;", Fingerprint.NormalizeShape(snippetA));
        Assert.Equal("id id = id(id) + lit;", Fingerprint.NormalizeShape(snippetB));
    }

    /// <summary>
    /// (2) A stage-2 compile-error artifact built from a long emitted G# line
    /// gets an identical fingerprint across two "runs" that differ only in
    /// identifier length within that line, even though the raw line exceeds
    /// the 160-char snippet cap.
    /// </summary>
    [Fact]
    public void CompileError_LongLineDifferingOnlyInIdentifierLength_DedupsToSameFingerprint()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");

        string LongLine(int padLength) => "let a = f(" + new string('x', padLength) + ") + 1;";

        var emittedA = new EmittedGsFile(
            "/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", "func F() {\n    " + LongLine(155) + "\n}\n");
        var emittedB = new EmittedGsFile(
            "/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", "func F() {\n    " + LongLine(120) + "\n}\n");

        var diagnostic = new GscDiagnostic("GS0100", "no overload for 'f'", "error", "Sample.gs", 2, 13);

        TriageArtifact a = builder.CompileError(diagnostic, emittedA);
        TriageArtifact b = builder.CompileError(diagnostic, emittedB);

        Assert.Equal(a.Fingerprint, b.Fingerprint);
    }

    /// <summary>
    /// (3) A G# line whose leading token is <c>let</c> but whose string
    /// literal body contains a keyword the old substring-scan heuristic would
    /// misfire on (<c>"for"</c>) classifies structurally as <c>LetConstruct</c>
    /// — the literal-content heuristic would have classified it as
    /// <c>ForConstruct</c> instead, splitting an otherwise-identical compile
    /// error's fingerprint on string-literal content.
    /// </summary>
    [Fact]
    public void CompileError_KeywordInsideStringLiteral_ClassifiesOnLeadingTokenNotLiteralContent()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");
        var emitted = new EmittedGsFile(
            "/abs/Sample.gs",
            "corpus_Sample/Sample.gs",
            "/abs/Sample.cs",
            "func F() {\n    let msg = \"run for cover\"\n}\n");
        var diagnostic = new GscDiagnostic("GS0313", "unexpected token", "error", "Sample.gs", 2, 5);

        TriageArtifact artifact = builder.CompileError(diagnostic, emitted);

        Assert.Equal("LetConstruct", artifact.OffendingCSharpConstruct.Kind);

        // A real `for` loop still classifies as ForConstruct, proving the fix
        // did not simply stop detecting `for` altogether.
        var emittedForLoop = new EmittedGsFile(
            "/abs/Sample.gs",
            "corpus_Sample/Sample.gs",
            "/abs/Sample.cs",
            "func F() {\n    for i in items {\n    }\n}\n");
        TriageArtifact forArtifact = builder.CompileError(diagnostic, emittedForLoop);
        Assert.Equal("ForConstruct", forArtifact.OffendingCSharpConstruct.Kind);

        // Two otherwise-identical compile errors that only differ by what a
        // string literal happens to contain must dedup to the same
        // fingerprint (the construct kind is a fingerprint component).
        var emittedOtherLiteral = new EmittedGsFile(
            "/abs/Sample.gs",
            "corpus_Sample/Sample.gs",
            "/abs/Sample.cs",
            "func F() {\n    let msg = \"while you wait\"\n}\n");
        TriageArtifact otherLiteralArtifact = builder.CompileError(diagnostic, emittedOtherLiteral);
        Assert.Equal(artifact.Fingerprint, otherLiteralArtifact.Fingerprint);
    }

    /// <summary>
    /// (B1, post-review regression) A construct line prefixed by one or more
    /// modifier keywords still classifies on the construct keyword that
    /// follows the modifiers — not on the leading modifier token itself,
    /// which would otherwise fall through to the generic <c>GSharpConstruct</c>
    /// bucket and collide structurally distinct gaps (e.g. a `sealed class`
    /// gap and an `async func` gap both fingerprinting as the same
    /// unclassified kind).
    /// </summary>
    [Theory]
    [InlineData("sealed class Shape {", "ClassConstruct")]
    [InlineData("async func Bump(n int32) int32 {", "FuncConstruct")]
    [InlineData("private func Helper(x int32) int32 {", "FuncConstruct")]
    [InlineData("public static async func F() {", "FuncConstruct")]
    public void CompileError_ModifierPrefixedConstruct_ClassifiesOnConstructKeyword(string gsLine, string expectedKind)
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");
        var emitted = new EmittedGsFile(
            "/abs/Sample.gs",
            "corpus_Sample/Sample.gs",
            "/abs/Sample.cs",
            "func Outer() {\n    " + gsLine + "\n}\n");
        var diagnostic = new GscDiagnostic("GS0313", "unexpected token", "error", "Sample.gs", 2, 5);

        TriageArtifact artifact = builder.CompileError(diagnostic, emitted);

        Assert.Equal(expectedKind, artifact.OffendingCSharpConstruct.Kind);
    }

    /// <summary>
    /// (B1) Two modifier-prefixed constructs of genuinely different kinds
    /// (`sealed class` vs `async func`) must NOT collapse to the same
    /// fingerprint — the regression this test guards against classified both
    /// as the generic bucket, colliding structurally distinct gaps.
    /// </summary>
    [Fact]
    public void CompileError_DifferentModifierPrefixedConstructs_ProduceDifferentFingerprints()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");
        var diagnostic = new GscDiagnostic("GS0313", "unexpected token", "error", "Sample.gs", 1, 5);

        var emittedSealedClass = new EmittedGsFile(
            "/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", "sealed class Shape {\n}\n");
        var emittedAsyncFunc = new EmittedGsFile(
            "/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", "async func Bump() {\n}\n");

        TriageArtifact a = builder.CompileError(diagnostic, emittedSealedClass);
        TriageArtifact b = builder.CompileError(diagnostic, emittedAsyncFunc);

        Assert.NotEqual(a.OffendingCSharpConstruct.Kind, b.OffendingCSharpConstruct.Kind);
        Assert.NotEqual(a.Fingerprint, b.Fingerprint);
    }

    /// <summary>
    /// (N1) Two crashes of the same exception type but with structurally
    /// different messages (after path-strip + normalize) must NOT collapse to
    /// the same fingerprint — the crash-message shape, not just
    /// <c>ex.GetType().Name</c>, is part of the fingerprint.
    /// </summary>
    [Fact]
    public void StageCrash_SameExceptionTypeDifferentMessageShape_ProducesDifferentFingerprint()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");

        var exFileNotFound = new InvalidOperationException(
            "Could not find file '/var/folders/T/cs2gsrun-0a1b2c/App/Program.cs' during stage 2.");
        var exBadState = new InvalidOperationException(
            "Operation is not valid due to the current state of the pipeline.");

        TriageArtifact a = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exFileNotFound);
        TriageArtifact b = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exBadState);

        Assert.Equal(a.OffendingCSharpConstruct.Kind, b.OffendingCSharpConstruct.Kind);
        Assert.NotEqual(a.Fingerprint, b.Fingerprint);
    }

    /// <summary>
    /// (N2) A single-segment absolute path (no interior directory segment,
    /// e.g. a bare run-scoped <c>/tmp</c> or <c>/root</c>) normalizes exactly
    /// like a multi-segment path and dedups stably across "runs" that only
    /// differ in that bare root.
    /// </summary>
    [Fact]
    public void NormalizeShape_NeutralizesSingleSegmentAbsolutePath()
    {
        Assert.Equal(
            Fingerprint.NormalizeShape("failed at 'lit'"),
            Fingerprint.NormalizeShape("failed at '/tmp'"));
        Assert.Equal(
            Fingerprint.NormalizeShape("failed at 'lit'"),
            Fingerprint.NormalizeShape("failed at '/root'"));

        // And it must not over-match ordinary non-path text containing a slash:
        // "3/4" is preceded by a digit, so the Unix-path branch must not
        // treat it as an absolute path (the numbers are still collapsed to
        // `lit` by the ordinary numeric-literal rule, not the path rule).
        Assert.Equal("id id lit/lit id id id", Fingerprint.NormalizeShape("the ratio 3/4 is not one"));
    }
}

