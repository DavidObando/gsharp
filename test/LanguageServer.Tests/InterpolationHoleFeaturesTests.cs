// <copyright file="InterpolationHoleFeaturesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

// IDE features (ADR-0055 Part C) must work inside interpolation holes ${...}, because the hole
// expressions are real sub-trees whose tokens carry absolute outer-file spans.
public class InterpolationHoleFeaturesTests
{
    [Fact]
    public void Hover_InsideHole_ResolvesSymbol()
    {
        const string source = "var name = 42\nvar s = \"hi ${name} end\"\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "name", 1));

        Assert.NotNull(hover);
        Assert.Contains("var name int32", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void Definition_InsideHole_PointsAtDeclaration()
    {
        const string source = "var name = 42\nvar s = \"hi ${name} end\"\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///hole.gs");

        var def = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "name", 1));

        Assert.NotNull(def);
        Assert.Equal(0, def.Range.Start.Line);
        Assert.Equal(4, def.Range.Start.Character);
    }

    [Fact]
    public void References_FromDeclaration_IncludeHoleUsage()
    {
        const string source = "var name = 42\nvar s = \"hi ${name} end\"\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///hole.gs");

        var references = ReferencesComputer.ComputeReferences(uri, content, LanguageServerTestHelpers.PositionOf(source, "name"), includeDeclaration: true);

        // Declaration on line 0 plus the usage inside the hole on line 1.
        Assert.Equal(2, references.Count);
        Assert.Contains(references, r => r.Range.Start.Line == 1);
    }

    [Fact]
    public void Completion_InsideHole_OffersInScopeSymbols()
    {
        const string source = "var answer = 42\nvar s = \"value=${}\"\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Position between the braces of ${}.
        var open = LanguageServerTestHelpers.PositionOf(source, "${");
        var position = new Position(open.Line, open.Character + 2);

        var items = CompletionComputer.ComputeCompletions(content, position);

        Assert.Contains(items, i => i.Label == "answer" && i.Kind == CompletionItemKind.Variable);
    }

    [Fact]
    public void SignatureHelp_InsideHole_ShowsCallSignature()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar s = \"r=${add(1, 2)} done\"\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Position just after the comma inside the hole call.
        var comma = LanguageServerTestHelpers.PositionOf(source, "1,");
        var position = new Position(comma.Line, comma.Character + 2);

        var help = SignatureHelpComputer.ComputeSignatureHelp(content, position);

        Assert.NotNull(help);
        Assert.Contains("add", help.Signatures.First().Label, System.StringComparison.Ordinal);
        Assert.Equal(1, help.ActiveParameter);
    }
}
