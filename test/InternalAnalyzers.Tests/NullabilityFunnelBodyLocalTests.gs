// <copyright file="NullabilityFunnelBodyLocalTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.InternalAnalyzers
import System
import System.Collections.Immutable
import System.Linq
import System.Reflection
import Xunit

/// ADR-0227 (issue #6184): GSA0007 declares `AnalyzerScope.MemberBody`, so the diagnostic-delta check
/// runs it on the edited body only and gives the delta of the full check.
class NullabilityFunnelBodyLocalTests {
    const Source string = `package GSharp.Core.CodeAnalysis.Symbols

import System

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()
    }
}

internal shared class Consumer {
    func Use(t Type) TypeSymbol {
        return TypeSymbol()
    }

    func Other(t Type) TypeSymbol {
        return TypeSymbol.FromClrType(t)
    }
}
`

    @Fact
    func AnEditInOneBody_IsCheckedBodyLocally_WithTheDeltaOfTheFullCheck() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "consumer.gs"))
        let compilation = Compilation([]SyntaxTree{tree})
        const oldText = "return TypeSymbol()"
        let start = Source.IndexOf(oldText, StringComparison.Ordinal)
        Assert.True(start >= 0)
        let changes = FixChanges(
            ImmutableArray.Create(
                DocumentChanges(
                    tree,
                    ImmutableArray.Create(
                        TextChange(
                            TextSpan(start, oldText.Length),
                            "let _ = TypeSymbol.FromClrType(t)\n        return TypeSymbol()"
                        )
                    ),
                    ImmutableArray[TextSpan].Empty
                )
            )
        )
        let analyzers = ImmutableArray.Create[GSharpDiagnosticAnalyzer](NullabilityFunnelAnalyzer())
        let service = CodeFixService(CodeFixRegistry())
        let full = service.ComputeDelta(
            DeltaBaseline.Create(compilation, DeltaOptions{BodyLocalBind: false, Analyzers: analyzers}),
            changes,
            ImmutableArray[Diagnostic].Empty
        )
        let local = service.ComputeDelta(
            DeltaBaseline.Create(compilation, DeltaOptions{Analyzers: analyzers}),
            changes,
            ImmutableArray[Diagnostic].Empty
        )
        Assert.False(ReadBodyLocal(full))
        Assert.True(ReadBodyLocal(local), ReadFallbackReason(local))
        // The new call in `Use` is reported (the edit keeps the return, so the narrowing of callers holds), and the call in `Other` persists.
        Assert.Equal("GSA0007", Assert.Single(local.Added, (d Diagnostic) -> d.Id == "GSA0007").Id)
        Assert.Single(local.Persisting, (d Diagnostic) -> d.Id == "GSA0007")
        Assert.Equal(Keys(full.Added), Keys(local.Added))
        Assert.Equal(Keys(full.Removed), Keys(local.Removed))
        Assert.Equal(Keys(full.Persisting), Keys(local.Persisting))
    }

    // The test project builds against the SDK's GSharp.Core, whose `DiagnosticDelta.BodyLocal` and
    // `BodyLocalFallbackReason` are internal, so the test reads them by reflection.
    private func ReadBodyLocal(delta DiagnosticDelta) bool -> cast[bool](
        typeof(DiagnosticDelta).GetProperty("BodyLocal", BindingFlags.Instance | BindingFlags.NonPublic)!!.GetValue(
            delta
        )!!
    )

    private func ReadFallbackReason(delta DiagnosticDelta) string -> typeof(DiagnosticDelta).GetProperty(
        "BodyLocalFallbackReason",
        BindingFlags.Instance | BindingFlags.NonPublic
    )!!
        .GetValue(delta)?.ToString() ?? "(none)"

    private func Keys(diagnostics ImmutableArray[Diagnostic]) string -> string.Join(
        "|",
        diagnostics.Select((d Diagnostic) -> "${d.Id}@${d.Location.Span.Start}:${d.Location.Span.Length}:${d.Message}")
            .OrderBy((k string) -> k, StringComparer.Ordinal)
    )
}
