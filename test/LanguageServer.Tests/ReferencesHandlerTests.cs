// <copyright file="ReferencesHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using OmniSharp.Extensions.LanguageServer.Protocol;
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
}
