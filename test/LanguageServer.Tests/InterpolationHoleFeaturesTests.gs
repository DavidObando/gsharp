// <copyright file="InterpolationHoleFeaturesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Linq
import Xunit

// IDE features (ADR-0055 Part C) must work inside interpolation holes ${...}, because the hole
// expressions are real sub-trees whose tokens carry absolute outer-file spans.
open class InterpolationHoleFeaturesTests {
    @Fact
    func Hover_InsideHole_ResolvesSymbol() {
        const source = `var name = 42
var s = "hi ${name} end"
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "name", 1))
        Assert.NotNull(hover)
        Assert.Contains("var name int32", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Definition_InsideHole_PointsAtDeclaration() {
        const source = `var name = 42
var s = "hi ${name} end"
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///hole.gs")!!
        let def Location? = DefinitionComputer.ComputeDefinition(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "name", 1)
        )
        Assert.NotNull(def)
        Assert.Equal(0, def!!.Range.Start.Line)
        Assert.Equal(4, def!!.Range.Start.Character)
    }

    @Fact
    func References_FromDeclaration_IncludeHoleUsage() {
        const source = `var name = 42
var s = "hi ${name} end"
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///hole.gs")!!
        let references = ReferencesComputer.ComputeReferences(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "name"),
            includeDeclaration: true
        )
        // Declaration on line 0 plus the usage inside the hole on line 1.
        Assert.Equal(2, references.Count)
        Assert.Contains(references, (r Location) -> r.Range.Start.Line == 1)
    }

    @Fact
    func Completion_InsideHole_OffersInScopeSymbols() {
        const source = `var answer = 42
var s = "value=${}"
`
        let content = LanguageServerTestHelpers.Content(source)
        // Position between the braces of ${}.
        let open_ = LanguageServerTestHelpers.PositionOf(source, "$${")
        let position = Position(open_.Line, open_.Character + 2)
        let items = CompletionComputer.ComputeCompletions(content, position)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "answer" && i.Kind == CompletionItemKind.Variable)
    }

    @Fact
    func SignatureHelp_InsideHole_ShowsCallSignature() {
        const source = `func add(a int32, b int32) int32 { return a + b }
var s = "r=${add(1, 2)} done"
`
        let content = LanguageServerTestHelpers.Content(source)
        // Position just after the comma inside the hole call.
        let comma = LanguageServerTestHelpers.PositionOf(source, "1,")
        let position = Position(comma.Line, comma.Character + 2)
        let help SignatureHelp? = SignatureHelpComputer.ComputeSignatureHelp(content, position)
        Assert.NotNull(help)
        Assert.Contains("add", help!!.Signatures.First().Label, StringComparison.Ordinal)
        Assert.Equal(1, help!!.ActiveParameter)
    }
}
