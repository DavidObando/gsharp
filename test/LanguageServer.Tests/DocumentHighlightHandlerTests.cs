// <copyright file="DocumentHighlightHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

public class DocumentHighlightHandlerTests
{
    [Fact]
    public void ComputeHighlights_ReturnsAllOccurrences()
    {
        const string source = "func F(x int32) int32 {\nlet y = x\nreturn x + y\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var tokens = ReferencesComputer.ComputeReferenceTokens(content, LanguageServerTestHelpers.PositionOf(source, "x"), includeDeclaration: true);

        Assert.Equal(3, tokens.Count);
    }

    [Fact]
    public void ComputeHighlights_NoSymbol_ReturnsEmpty()
    {
        const string source = "let x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);

        var tokens = ReferencesComputer.ComputeReferenceTokens(content, LanguageServerTestHelpers.PositionOf(source, "42"), includeDeclaration: true);

        Assert.Empty(tokens);
    }
}
