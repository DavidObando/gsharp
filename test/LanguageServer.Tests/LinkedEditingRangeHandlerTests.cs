// <copyright file="LinkedEditingRangeHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class LinkedEditingRangeHandlerTests
{
    [Fact]
    public void LinkedEditing_ReturnsAllOccurrencesOfVariable()
    {
        const string source = "var x = 1\nvar y = x + 2\n";
        var content = LanguageServerTestHelpers.Content(source);
        var compilation = new Compilation(content.SyntaxTree);

        var position = LanguageServerTestHelpers.PositionOf(source, "x");
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);

        Assert.True(SemanticLookup.CanRename(symbol));
        var references = SemanticLookup.FindReferences(compilation, symbol).ToList();

        // x appears in declaration and in expression
        Assert.Equal(2, references.Count);
    }

    [Fact]
    public void LinkedEditing_NonRenamableReturnsNoRanges()
    {
        const string source = "var x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var compilation = new Compilation(content.SyntaxTree);

        // Position on a keyword
        var position = LanguageServerTestHelpers.PositionOf(source, "var");
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);

        // Keywords should not be identifier tokens
        Assert.NotEqual(SyntaxKind.IdentifierToken, token.Kind);
    }

    [Fact]
    public void LinkedEditing_GlobalVariableUsedMultipleTimes()
    {
        const string source = "var n = 1\nvar m = n + n\n";
        var content = LanguageServerTestHelpers.Content(source);
        var compilation = new Compilation(content.SyntaxTree);

        // Position on 'n' in the second line
        var position = LanguageServerTestHelpers.PositionOf(source, "n", 1);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);

        Assert.NotNull(symbol);
        Assert.True(SemanticLookup.CanRename(symbol));
        var references = SemanticLookup.FindReferences(compilation, symbol).ToList();

        // n appears in declaration and twice in expression
        Assert.Equal(3, references.Count);
    }
}
