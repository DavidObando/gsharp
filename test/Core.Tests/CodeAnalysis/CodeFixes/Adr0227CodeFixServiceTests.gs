// <copyright file="Adr0227CodeFixServiceTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading
import Xunit

/// ADR-0227 D2: providers register by diagnostic ID, the service lists and applies their fixes,
/// and a provider that throws gives GS9308 instead of a fix.
open class Adr0227CodeFixServiceTests {
    const Source string = "package P\n\nfunc F() string? {\n    // keep\n    return null\n}\n"

    @Fact
    func GetFixes_ForADiagnostic_ReturnsTheProviderFix_AndApplyEditsTheText() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "a.gs"))
        let compilation = Compilation(tree)
        let diagnostic = Assert.Single(compilation.GetDiagnostics())
        Assert.Equal("GS0273", diagnostic.Id)
        let service = CodeFixService(Registry(TestNilProvider()))
        let fix = Assert.Single(service.GetFixes(compilation, diagnostic))
        Assert.Equal("Use 'nil'", fix.Title)
        Assert.Equal(Applicability.MachineApplicable, fix.Applicability)
        Assert.Same(diagnostic, Assert.Single(fix.Diagnostics))
        let newTree = Assert.Single(service.Apply(fix))
        Assert.Equal("package P\n\nfunc F() string? {\n    // keep\n    return nil\n}\n", newTree.Text.ToString())
        Assert.Equal("a.gs", newTree.Text.FileName)
        Assert.Empty(Compilation(newTree).GetDiagnostics())
    }

    @Fact
    func GetChanges_IsComputedOnce() {
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let provider = TestNilProvider()
        let fix = Assert.Single(
            CodeFixService(Registry(provider)).GetFixes(compilation, compilation.GetDiagnostics()[0])
        )
        Assert.Equal(0, provider.ComputeCount)
        let first = fix.GetChanges()
        Assert.Same(first, fix.GetChanges())
        Assert.Equal(1, provider.ComputeCount)
    }

    @Fact
    func GetFixes_BySpan_HitsOnlyOverlappingDiagnostics() {
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let service = CodeFixService(Registry(TestNilProvider()))
        let at = Source.IndexOf("null", StringComparison.Ordinal)
        Assert.Single(service.GetFixes(compilation, tree, TextSpan(at + 2, 0), ImmutableArray[Diagnostic].Empty, out _))
        Assert.Empty(service.GetFixes(compilation, tree, TextSpan(0, 3), ImmutableArray[Diagnostic].Empty, out _))
    }

    @Fact
    func ThrowingProvider_GivesGS9308_AndOtherProvidersStillRun() {
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let service = CodeFixService(Registry(ThrowingProvider(), TestNilProvider()))
        let fixes = service.GetFixes(compilation, compilation.GetDiagnostics()[0], out var failures)
        Assert.Single(fixes)
        let failure = Assert.Single(failures)
        Assert.Equal("GS9308", failure.Id)
        Assert.Equal(DiagnosticSeverity.Warning, failure.Severity)
        Assert.Contains("ThrowingProvider", failure.Message, StringComparison.Ordinal)
    }

    @Fact
    func Registry_RejectsAProviderWithNoFixableId() {
        Assert.Throws[ArgumentException](() -> CodeFixRegistry().Add(NoIdProvider()))
    }

    @Fact
    func Registry_KeepsRegistrationOrder() {
        let first = TestNilProvider()
        let second = TestNilProvider()
        let registry = Registry(first, second)
        Assert.Equal(2, registry.GetProviders("GS0273").Length)
        Assert.Same(first, registry.GetProviders("GS0273")[0])
        Assert.Empty(registry.GetProviders("GS0001"))
    }

    @Fact
    func WithLowerApplicability_NeverRaises() {
        let tree = SyntaxTree.Parse(Source)
        let compilation = Compilation(tree)
        let fix = Assert.Single(
            CodeFixService(Registry(TestNilProvider())).GetFixes(compilation, compilation.GetDiagnostics()[0])
        )
        let lowered = fix.WithLowerApplicability(Applicability.MaybeIncorrect)
        Assert.Equal(Applicability.MaybeIncorrect, lowered.Applicability)
        Assert.Same(lowered, lowered.WithLowerApplicability(Applicability.MachineApplicable))
        Assert.Same(fix.GetChanges(), lowered.GetChanges())
    }

    @Fact
    func DiagnosticOfAnotherCompilation_HasNoFix() {
        let compilation = Compilation(SyntaxTree.Parse(Source))
        let other = Compilation(SyntaxTree.Parse(Source))
        let service = CodeFixService(Registry(TestNilProvider()))
        Assert.Empty(service.GetFixes(compilation, other.GetDiagnostics()[0]))
    }

    @Fact
    func AnalyzerHost_LoadsAttributedProviders_InTypeNameOrder() {
        let path = typeof(Adr0227CodeFixServiceTests).Assembly.Location
        let providers = GSharpAnalyzerHost.LoadCodeFixProviders([]string{path}, out var diagnostics)
        Assert.Empty(diagnostics)
        let names = providers.Select((p GSharpCodeFixProvider) -> p.GetType().FullName).ToList()
        Assert.Equal(
            []string{
                "GSharp.Core.Tests.CodeAnalysis.CodeFixes.Adr0227LoadableProviderA",
                "GSharp.Core.Tests.CodeAnalysis.CodeFixes.Adr0227LoadableProviderB"
            },
            names
        )
    }

    private func Registry(providers ...GSharpCodeFixProvider) CodeFixRegistry {
        let registry = CodeFixRegistry()
        registry.AddRange(providers)
        return registry
    }

    private class TestNilProvider : GSharpCodeFixProvider {
        prop ComputeCount int32 {
            get;
            set;
        }

        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            let span = context.Diagnostic.Location.Span
            let token = context.Tree.Root.FindToken(span.Start)!!
            context.RegisterFix(
                "Use 'nil'",
                "test.nil",
                Applicability.MachineApplicable,
                (editor SyntaxEditor) -> {
                    ComputeCount = ComputeCount + 1
                    editor.ReplaceToken(token, "nil")
                }
            )
        }
    }

    private class ThrowingProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            throw InvalidOperationException("broken")
        }
    }

    private class NoIdProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray[string].Empty

        override func RegisterCodeFixes(context CodeFixContext) { }
    }
}

/// A provider that (cref:GSharpAnalyzerHost.LoadCodeFixProviders) discovers (ADR-0227 D2).
@GSharpCodeFixProvider
class Adr0227LoadableProviderB : GSharpCodeFixProvider {
    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("TEST0227")

    override func RegisterCodeFixes(context CodeFixContext) { }
}

/// A provider that (cref:GSharpAnalyzerHost.LoadCodeFixProviders) discovers (ADR-0227 D2).
@GSharpCodeFixProvider
class Adr0227LoadableProviderA : GSharpCodeFixProvider {
    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("TEST0227")

    override func RegisterCodeFixes(context CodeFixContext) { }
}

/// A provider without the attribute, which discovery skips.
class Adr0227UnmarkedProvider : GSharpCodeFixProvider {
    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("TEST0227")

    override func RegisterCodeFixes(context CodeFixContext) { }
}
