// <copyright file="Issue1750TriageFingerprintStabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import Xunit

/// Regression tests for issue #1750: triage fingerprints must be stable
/// across runs/machines for the same underlying gap. Covers all three
/// reported leaks: (1) crash artifacts embedding run-scoped absolute paths
/// from (cref:Exception.Message), (2) snippets truncated before shape
/// normalization instead of after, and (3) construct-kind classification
/// matching keyword text anywhere in a line (including inside string
/// literals) instead of the line's leading (structural) token.
open class Issue1750TriageFingerprintStabilityTests {
    /// (1) A stage crash fingerprints identically across two "runs" whose
    /// exception messages differ only in their embedded run-scoped absolute
    /// paths (a different hex run id and a different absolute root each
    /// time, one Unix-style and one Windows-style) — the same recurring
    /// defect must dedup into one issue instead of filing a fresh one every
    /// run/machine.
    @Fact
    func StageCrash_SamePathVaryingRuns_ProducesIdenticalFingerprint() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let exUnixRun1 = InvalidOperationException(
            "Could not find file '/var/folders/T/cs2gsrun-0a1b2c3d4e/App/Program.cs' during stage 2."
        )
        let exUnixRun2 = InvalidOperationException(
            "Could not find file '/tmp/cs2gsrun-9f8e7d6c5b4a3210/App/Program.cs' during stage 2."
        )
        let exWindowsRun = InvalidOperationException(
            "Could not find file 'C:\\Users\\ci\\AppData\\Local\\Temp\\cs2gsrun-abc123\\App\\Program.cs' during stage 2."
        )
        let a = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exUnixRun1)
        let b = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exUnixRun2)
        let c = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exWindowsRun)
        Assert.Equal(a.Fingerprint, b.Fingerprint)
        Assert.Equal(a.Fingerprint, c.Fingerprint)
        Assert.StartsWith("sha256:", a.Fingerprint, StringComparison.Ordinal)
        // The construct kind anchors on the deterministic exception type, not
        // free-text pulled from the message.
        Assert.Equal("InvalidOperationException", a.OffendingCSharpConstruct!!.Kind)
        // A genuinely different exception type for the same stage must still
        // split into its own fingerprint (it is a different underlying gap).
        let d = builder.StageCrash(
            MigrationStageKind.Compile,
            TriageCategory.CompileError,
            "GS9999",
            NullReferenceException("Object reference not set to an instance of an object.")
        )
        Assert.NotEqual(a.Fingerprint, d.Fingerprint)
    }

    /// (1, generalized) (cref:Fingerprint.NormalizeShape) neutralizes
    /// any absolute path under any root — not just one hardcoded prefix — for
    /// both Unix and Windows/UNC-style paths.
    @Fact
    func NormalizeShape_NeutralizesAnyAbsolutePath_RegardlessOfRoot() {
        Assert.Equal(
            Fingerprint.NormalizeShape("failed at 'lit'"),
            Fingerprint.NormalizeShape("failed at '/var/folders/T/cs2gsrun-0a1b2c/App/Program.cs'")
        )
        Assert.Equal(
            Fingerprint.NormalizeShape("failed at 'lit'"),
            Fingerprint.NormalizeShape("failed at 'C:\\Users\\ci\\Temp\\cs2gsrun-9f9f\\App\\Program.cs'")
        )
        Assert.Equal(
            Fingerprint.NormalizeShape("failed at 'lit'"),
            Fingerprint.NormalizeShape("failed at '\\\\build-host\\share\\cs2gsrun-42\\App\\Program.cs'")
        )
    }

    /// (2) A snippet longer than the truncation cap whose head is identical
    /// except for pre-normalization noise (here: two differently-sized string
    /// literal and identifier runs that push the rest of the snippet to
    /// different absolute offsets) must still normalize to the exact same
    /// shape and fingerprint — the truncation boundary must be computed on
    /// already-normalized text, not on the raw snippet.
    @Fact
    func Fingerprint_NormalizesBeforeTruncating_SoLongSnippetsWithDifferentNoiseDedup() {
        // Same construct — `let a = f(<identifier>) + 1;` — but the
        // identifier bound inside f(...) has a very different length, so a
        // naive "truncate raw text at N chars, then normalize" pipeline would
        // cut one snippet mid-argument (dropping the closing paren and the
        // "+ 1;" tail) and the other past the closing paren (keeping it),
        // producing two different shapes for what is structurally the same
        // gap.
        let snippetA = "let a = f(" + String('x', 155) + ") + 1;"
        let snippetB = "let a = f(" + String('x', 145) + ") + 1;"
        Assert.True(snippetA.Length > 160 || snippetB.Length > 160, "test setup must exceed the truncation cap")
        let fingerprintA = Fingerprint.Compute("compile-error", "compile", "GS0100", "GSharpConstruct", snippetA)
        let fingerprintB = Fingerprint.Compute("compile-error", "compile", "GS0100", "GSharpConstruct", snippetB)
        Assert.Equal(fingerprintA, fingerprintB)
        // And the normalized shape is exactly what normalize-then-truncate
        // predicts: the identifier is fully collapsed before any cap applies.
        Assert.Equal("id id = id(id) + lit;", Fingerprint.NormalizeShape(snippetA))
        Assert.Equal("id id = id(id) + lit;", Fingerprint.NormalizeShape(snippetB))
    }

    /// (2) A stage-2 compile-error artifact built from a long emitted G# line
    /// gets an identical fingerprint across two "runs" that differ only in
    /// identifier length within that line, even though the raw line exceeds
    /// the 160-char snippet cap.
    @Fact
    func CompileError_LongLineDifferingOnlyInIdentifierLength_DedupsToSameFingerprint() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let LongLine = func (padLength int32) string {
            return "let a = f(" + String('x', padLength) + ") + 1;"
        }
        let emittedA = EmittedGsFile(
            "/abs/Sample.gs",
            "corpus_Sample/Sample.gs",
            "/abs/Sample.cs",
            "func F() {\n    " + LongLine(155) + `
}
`
        )
        let emittedB = EmittedGsFile(
            "/abs/Sample.gs",
            "corpus_Sample/Sample.gs",
            "/abs/Sample.cs",
            "func F() {\n    " + LongLine(120) + `
}
`
        )
        let diagnostic = GscDiagnostic("GS0100", "no overload for 'f'", "error", "Sample.gs", 2, 13)
        let a = builder.CompileError(diagnostic, emittedA)
        let b = builder.CompileError(diagnostic, emittedB)
        Assert.Equal(a.Fingerprint, b.Fingerprint)
    }

    /// (3) A G# line whose leading token is `let` but whose string
    /// literal body contains a keyword the old substring-scan heuristic would
    /// misfire on (`"for"`) classifies structurally as `LetConstruct`
    /// — the literal-content heuristic would have classified it as
    /// `ForConstruct` instead, splitting an otherwise-identical compile
    /// error's fingerprint on string-literal content.
    @Fact
    func CompileError_KeywordInsideStringLiteral_ClassifiesOnLeadingTokenNotLiteralContent() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let emitted = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `func F() {
    let msg = "run for cover"
}
`)
        let diagnostic = GscDiagnostic("GS0313", "unexpected token", "error", "Sample.gs", 2, 5)
        let artifact = builder.CompileError(diagnostic, emitted)
        Assert.Equal("LetConstruct", artifact.OffendingCSharpConstruct!!.Kind)
        // A real `for` loop still classifies as ForConstruct, proving the fix
        // did not simply stop detecting `for` altogether.
        let emittedForLoop = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `func F() {
    for i in items {
    }
}
`)
        let forArtifact = builder.CompileError(diagnostic, emittedForLoop)
        Assert.Equal("ForConstruct", forArtifact.OffendingCSharpConstruct!!.Kind)
        // Two otherwise-identical compile errors that only differ by what a
        // string literal happens to contain must dedup to the same
        // fingerprint (the construct kind is a fingerprint component).
        let emittedOtherLiteral = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `func F() {
    let msg = "while you wait"
}
`)
        let otherLiteralArtifact = builder.CompileError(diagnostic, emittedOtherLiteral)
        Assert.Equal(artifact.Fingerprint, otherLiteralArtifact.Fingerprint)
    }

    /// (B1, post-review regression) A construct line prefixed by one or more
    /// modifier keywords still classifies on the construct keyword that
    /// follows the modifiers — not on the leading modifier token itself,
    /// which would otherwise fall through to the generic `GSharpConstruct`
    /// bucket and collide structurally distinct gaps (e.g. a `sealed class`
    /// gap and an `async func` gap both fingerprinting as the same
    /// unclassified kind).
    ///
    /// (#1851, residual of B1) `GSharpPrinter.RenderKindKeyword` emits
    /// the compound keyword `inline struct` for
    /// `TypeDeclarationKind.InlineStruct`. Its leading token, `inline`,
    /// is neither a construct keyword nor (pre-fix) a recognized modifier, so
    /// a modifier-free `inline struct Foo {` line fell through to the generic
    /// bucket instead of classifying as `StructConstruct` alongside plain
    /// `struct` and modifier-prefixed `inline struct` declarations.
    @Theory
    @InlineData("sealed class Shape {", "ClassConstruct")
    @InlineData("async func Bump(n int32) int32 {", "FuncConstruct")
    @InlineData("private func Helper(x int32) int32 {", "FuncConstruct")
    @InlineData("public static async func F() {", "FuncConstruct")
    @InlineData("inline struct Foo {", "StructConstruct")
    @InlineData("public inline struct Bar {", "StructConstruct")
    func CompileError_ModifierPrefixedConstruct_ClassifiesOnConstructKeyword(gsLine string, expectedKind string) {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let emitted = EmittedGsFile(
            "/abs/Sample.gs",
            "corpus_Sample/Sample.gs",
            "/abs/Sample.cs",
            "func Outer() {\n    " + gsLine + `
}
`
        )
        let diagnostic = GscDiagnostic("GS0313", "unexpected token", "error", "Sample.gs", 2, 5)
        let artifact = builder.CompileError(diagnostic, emitted)
        Assert.Equal(expectedKind, artifact.OffendingCSharpConstruct!!.Kind)
    }

    /// (B1) Two modifier-prefixed constructs of genuinely different kinds
    /// (`sealed class` vs `async func`) must NOT collapse to the same
    /// fingerprint — the regression this test guards against classified both
    /// as the generic bucket, colliding structurally distinct gaps.
    @Fact
    func CompileError_DifferentModifierPrefixedConstructs_ProduceDifferentFingerprints() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let diagnostic = GscDiagnostic("GS0313", "unexpected token", "error", "Sample.gs", 1, 5)
        let emittedSealedClass = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `sealed class Shape {
}
`)
        let emittedAsyncFunc = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `async func Bump() {
}
`)
        let a = builder.CompileError(diagnostic, emittedSealedClass)
        let b = builder.CompileError(diagnostic, emittedAsyncFunc)
        Assert.NotEqual(a.OffendingCSharpConstruct!!.Kind, b.OffendingCSharpConstruct!!.Kind)
        Assert.NotEqual(a.Fingerprint, b.Fingerprint)
    }

    /// (N1) Two crashes of the same exception type but with structurally
    /// different messages (after path-strip + normalize) must NOT collapse to
    /// the same fingerprint — the crash-message shape, not just
    /// `ex.GetType().Name`, is part of the fingerprint.
    @Fact
    func StageCrash_SameExceptionTypeDifferentMessageShape_ProducesDifferentFingerprint() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let exFileNotFound = InvalidOperationException(
            "Could not find file '/var/folders/T/cs2gsrun-0a1b2c/App/Program.cs' during stage 2."
        )
        let exBadState = InvalidOperationException("Operation is not valid due to the current state of the pipeline.")
        let a = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exFileNotFound)
        let b = builder.StageCrash(MigrationStageKind.Compile, TriageCategory.CompileError, "GS9999", exBadState)
        Assert.Equal(a.OffendingCSharpConstruct!!.Kind, b.OffendingCSharpConstruct!!.Kind)
        Assert.NotEqual(a.Fingerprint, b.Fingerprint)
    }

    /// (#1851) `inline struct` fingerprints identically to plain `struct` on
    /// construct kind (both `StructConstruct`) since both are the same
    /// underlying declaration shape, but stays distinct from an unrelated
    /// `func` construct — proving the `inline` fix lands on the correct
    /// following keyword rather than merging distinct construct kinds.
    @Fact
    func CompileError_InlineStruct_MatchesPlainStructButNotFunc() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let diagnostic = GscDiagnostic("GS0313", "unexpected token", "error", "Sample.gs", 1, 5)
        let emittedInlineStruct = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `inline struct Foo {
}
`)
        let emittedPlainStruct = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `struct Foo {
}
`)
        let emittedFunc = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `func Foo() {
}
`)
        let a = builder.CompileError(diagnostic, emittedInlineStruct)
        let b = builder.CompileError(diagnostic, emittedPlainStruct)
        let c = builder.CompileError(diagnostic, emittedFunc)
        Assert.Equal("StructConstruct", a.OffendingCSharpConstruct!!.Kind)
        Assert.Equal(a.OffendingCSharpConstruct!!.Kind, b.OffendingCSharpConstruct!!.Kind)
        Assert.NotEqual(a.OffendingCSharpConstruct!!.Kind, c.OffendingCSharpConstruct!!.Kind)
        Assert.NotEqual(a.Fingerprint, c.Fingerprint)
    }

    /// (N2) A single-segment absolute path (no interior directory segment,
    /// e.g. a bare run-scoped `/tmp` or `/root`) normalizes exactly
    /// like a multi-segment path and dedups stably across "runs" that only
    /// differ in that bare root.
    @Fact
    func NormalizeShape_NeutralizesSingleSegmentAbsolutePath() {
        Assert.Equal(Fingerprint.NormalizeShape("failed at 'lit'"), Fingerprint.NormalizeShape("failed at '/tmp'"))
        Assert.Equal(Fingerprint.NormalizeShape("failed at 'lit'"), Fingerprint.NormalizeShape("failed at '/root'"))
        // And it must not over-match ordinary non-path text containing a slash:
        // "3/4" is preceded by a digit, so the Unix-path branch must not
        // treat it as an absolute path (the numbers are still collapsed to
        // `lit` by the ordinary numeric-literal rule, not the path rule).
        Assert.Equal("id id lit/lit id id id", Fingerprint.NormalizeShape("the ratio 3/4 is not one"))
    }
}
