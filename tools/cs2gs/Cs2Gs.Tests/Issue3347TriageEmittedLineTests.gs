// <copyright file="Issue3347TriageEmittedLineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import Xunit

/// Issue #3347: a compile-error triage artifact must quote the EMITTED G# line
/// the diagnostic points at, and must say so plainly when it cannot.
///
/// Working through the oahu gate, every failing app reported the diagnostic
/// MESSAGE in the "Offending line" field and left "Emitted G#" blank — because
/// the file lookup returned null and `CompileError` silently substituted
/// `diagnostic.Message`. Indistinguishable from a real source line to
/// anyone reading the report, and it made four CI round-trips necessary to find
/// what one local run would have shown.
open class Issue3347TriageEmittedLineTests {
    /// The resolved case: the artifact quotes the emitted line, not the message.
    @Fact
    func ResolvedFile_QuotesTheEmittedLine() {
        let emitted = EmittedGsFile(
            "/abs/migrated/src/App/Program.gs",
            "src_App/Program.gs",
            "/abs/src/App/Program.cs",
            GsSource
        )
        let diagnostic = GscDiagnostic(
            "GS0100",
            "some diagnostic text",
            "error",
            "/abs/migrated/src/App/Program.gs",
            2,
            13
        )
        let artifact = NewBuilder().CompileError(diagnostic, emitted)
        Assert.Contains("let x = broken(", artifact.OffendingCSharpConstruct!!.Snippet, StringComparison.Ordinal)
        Assert.DoesNotContain(
            "some diagnostic text",
            artifact.OffendingCSharpConstruct!!.Snippet,
            StringComparison.Ordinal
        )
        Assert.Equal("src_App/Program.gs", artifact.SourceLocation.GsFile)
    }

    /// The unresolved case must be self-describing rather than silently
    /// substituting the diagnostic message.
    @Fact
    func UnresolvedFile_SaysSo_RatherThanQuotingTheMessage() {
        let diagnostic = GscDiagnostic(
            "GS0100",
            "some diagnostic text",
            "error",
            "/abs/migrated/src/App/Program.gs",
            2,
            13
        )
        let artifact = NewBuilder().CompileError(diagnostic, file: nil)
        Assert.Contains(
            "emitted G# line unavailable",
            artifact.OffendingCSharpConstruct!!.Snippet,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain(
            "some diagnostic text",
            artifact.OffendingCSharpConstruct!!.Snippet,
            StringComparison.Ordinal
        )
    }

    /// The `--via-sdk` path routes gsc through MSBuild, which may report a
    /// path relative to the project directory. Resolving that against cs2gs's
    /// working directory does not match, so the matcher compares path suffixes.
    @Fact
    func ProjectRelativeDiagnosticPath_Resolves() {
        let emitted = EmittedGsFile(
            "/abs/migrated/src/App/Auxiliary/Helper.gs",
            "src_App/Auxiliary/Helper.gs",
            "/abs/src/App/Auxiliary/Helper.cs",
            GsSource
        )
        let match = CompileStage.MatchEmittedFile([]EmittedGsFile{emitted}, "Auxiliary/Helper.gs")!!
        Assert.Same(emitted, match)
    }

    /// An absolute path from a direct gsc invocation resolves exactly.
    @Fact
    func AbsoluteDiagnosticPath_Resolves() {
        let emitted = EmittedGsFile(
            "/abs/migrated/src/App/Program.gs",
            "src_App/Program.gs",
            "/abs/src/App/Program.cs",
            GsSource
        )
        let match = CompileStage.MatchEmittedFile([]EmittedGsFile{emitted}, "/abs/migrated/src/App/Program.gs")!!
        Assert.Same(emitted, match)
    }

    /// A basename shared with a referenced sibling project used to make the
    /// lookup ambiguous and return null, which silently degraded the whole
    /// artifact. The app's own file wins.
    @Fact
    func BasenameCollidingWithSibling_PrefersTheAppsOwnFile() {
        let own = EmittedGsFile("/abs/migrated/src/App/Extensions.gs", "src_App/Extensions.gs", "/abs/a.cs", GsSource)
        let sibling = EmittedGsFile(
            "/abs/migrated/src/Other/Extensions.gs",
            "src_Other/Extensions.gs",
            "/abs/b.cs",
            GsSource
        ){IsFromReferencedProject = true}
        let match = CompileStage.MatchEmittedFile([]EmittedGsFile{sibling, own}, "Extensions.gs")!!
        Assert.Same(own, match)
    }

    /// A genuinely ambiguous basename — two of the app's OWN files — stays
    /// unresolved rather than guessing, which the explicit marker then reports.
    @Fact
    func AmbiguousBasenameAcrossOwnFiles_StaysUnresolved() {
        let first = EmittedGsFile("/abs/a/Shared.gs", "app/a/Shared.gs", "/abs/a.cs", GsSource)
        let second = EmittedGsFile("/abs/b/Shared.gs", "app/b/Shared.gs", "/abs/b.cs", GsSource)
        Assert.Null(CompileStage.MatchEmittedFile([]EmittedGsFile{first, second}, "Shared.gs"))
    }

    shared {
        private const GsSource string = `func F() {
    let x = broken(
}
`

        private func NewBuilder() TriageBuilder -> TriageBuilder(
            "run_1",
            "2026-08-11T00:00:00Z",
            "0.3.0+abc",
            "src/App/App.csproj"
        )
    }
}
