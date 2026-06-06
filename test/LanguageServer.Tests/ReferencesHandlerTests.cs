// <copyright file="ReferencesHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class ReferencesHandlerTests
{
    [Fact]
    public void ComputeReferences_ReturnsAllSingleDocumentOccurrences()
    {
        const string source = "func F(x int32) int32 {\nlet y = x\nreturn x + y\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///refs.gs");

        var references = ReferencesComputer.ComputeReferences(uri, content, LanguageServerTestHelpers.PositionOf(source, "x"), includeDeclaration: true);

        Assert.Equal(3, references.Count);
        Assert.All(references, r => Assert.Equal(uri, r.Uri));
    }

    [Fact]
    public void ComputeReferences_CanExcludeDeclaration()
    {
        const string source = "func F(x int32) int32 {\nlet y = x\nreturn x + y\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var tokens = ReferencesComputer.ComputeReferenceTokens(content, LanguageServerTestHelpers.PositionOf(source, "x"), includeDeclaration: false);

        Assert.Equal(2, tokens.Count);
        Assert.All(tokens, t => Assert.NotEqual(7, t.Position));
    }

    [Fact]
    public void ComputeReferences_RepeatedCallsReturnIdenticalResults()
    {
        // Hot-path regression: SemanticModel now memoizes the Symbol → tokens index
        // so CodeLens (which calls FindReferences once per member) doesn't re-walk
        // every tree on every call. The cache must return identical results across
        // calls; if invalidation logic ever desyncs the cache, this test catches it.
        const string source = "func F(x int32) int32 {\nlet y = x\nreturn x + y + x\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var pos = LanguageServerTestHelpers.PositionOf(source, "x");

        var first = ReferencesComputer.ComputeReferenceTokens(content, pos, includeDeclaration: true);
        var second = ReferencesComputer.ComputeReferenceTokens(content, pos, includeDeclaration: true);
        var third = ReferencesComputer.ComputeReferenceTokens(content, pos, includeDeclaration: true);

        Assert.Equal(first.Count, second.Count);
        Assert.Equal(first.Count, third.Count);
        for (var i = 0; i < first.Count; i++)
        {
            Assert.Equal(first[i].Position, second[i].Position);
            Assert.Equal(first[i].Position, third[i].Position);
        }
    }
}
