// <copyright file="Issue6177DiagnosticPhaseTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System
import System.IO
import System.Linq
import Xunit

/// Issue #6177 (item 2): `Diagnostic.Phase` names the pipeline that reported a diagnostic. Each pipeline
/// stamps the diagnostics it returns, so the stamp survives every query that returns them.
open class Issue6177DiagnosticPhaseTests {
    @Fact
    func ParseDiagnostic_IsParse() {
        let tree = SyntaxTree.Parse(SourceText.From("package P\n\nfunc Main( {\n}\n", "parse.gs"))
        let parse = Assert.Single(tree.Diagnostics.Take(1))
        Assert.Equal(DiagnosticPhase.Parse, parse.Phase)
        let reported = Compilation(tree).GetDiagnostics().First((d Diagnostic) -> object.ReferenceEquals(d, parse))
        Assert.Equal(DiagnosticPhase.Parse, reported.Phase)
        Assert.All(tree.Diagnostics, (d Diagnostic) -> Assert.Equal(DiagnosticPhase.Parse, d.Phase))
    }

    @Fact
    func DeclarationAndBodyDiagnostics_HaveTheirPipeline() {
        let compilation = Compile(
            "package P\n\nclass C {\n}\n\nclass C {\n}\n\nfunc Main() {\n    let x int32 = \"s\"\n}\n"
        )
        let diagnostics = compilation.GetDiagnostics()
        Assert.Equal(DiagnosticPhase.Declaration, diagnostics.First((d Diagnostic) -> d.Id == "GS0102").Phase)
        Assert.Equal(DiagnosticPhase.Body, diagnostics.First((d Diagnostic) -> d.Id == "GS0155").Phase)
        // The partial queries return the same diagnostics with the same phase.
        Assert.All(
            compilation.GetDeclarationDiagnostics(),
            (d Diagnostic) -> Assert.Equal(DiagnosticPhase.Declaration, d.Phase)
        )
        Assert.All(compilation.GetBodyDiagnostics(), (d Diagnostic) -> Assert.Equal(DiagnosticPhase.Body, d.Phase))
        Assert.NotEmpty(compilation.GetDeclarationDiagnostics())
        Assert.NotEmpty(compilation.GetBodyDiagnostics())
    }

    @Fact
    func MissingEntryPointAndDocumentation_AreDeclaration() {
        let compilation = Compile("package P\n\nfunc Helper() {\n}\n")
        Assert.Equal(DiagnosticPhase.Declaration, Assert.Single(compilation.GetMissingEntryPointDiagnostics()).Phase)
        let documented = Compile("package P\n\n/// @param missing Not a parameter.\nfunc Main() {\n}\n")
        let documentation = documented.GetDiagnostics()
        Assert.NotEmpty(documentation)
        Assert.All(documentation, (d Diagnostic) -> Assert.Equal(DiagnosticPhase.Declaration, d.Phase))
    }

    @Fact
    func EmitDiagnostic_IsEmit() {
        using let contracts = Issue4503ImportedAttributeContracts()
        using let resolver = ReferenceResolver.WithReferences([]string{contracts.Path})
        let source = "import Issue4503.Contracts\n\n@ImportedNamedConstructor(third: 3, 2)\nclass Tagged {\n}\n"
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0583")
        using let stream = MemoryStream()
        let result = compilation.Emit(stream)
        Assert.Equal(DiagnosticPhase.Emit, result.Diagnostics.Single((d Diagnostic) -> d.Id == "GS0583").Phase)
    }

    @Fact
    func PrefixBindCopiesAndHostDiagnostics_KeepOrLackThePhase() {
        const source = "package P\n\nfunc Main() {\n    let x int32 = \"s\"\n    let y = 1\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "prefix.gs"))
        let result = Compilation(tree).BindPrefix(tree, source.Length, PrefixBindOptions(PrefixRemainder.Nothing))
        let mismatch = result.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Diagnostic
        Assert.Equal(DiagnosticPhase.Body, mismatch.Phase)
        // A copy with another severity (severity configuration) keeps the phase.
        Assert.Equal(DiagnosticPhase.Body, mismatch.WithSeverity(DiagnosticSeverity.Warning).Phase)
        // A diagnostic that a host creates has none.
        Assert.Equal(
            DiagnosticPhase.Unknown,
            Diagnostic(TextLocation(tree.Text, TextSpan(0, 1)), "GS0000", DiagnosticSeverity.Error, "host").Phase
        )
    }

    shared {
        private func Compile(source string) Compilation -> Compilation(
            SyntaxTree.Parse(SourceText.From(source, "phase.gs"))
        )
    }
}
