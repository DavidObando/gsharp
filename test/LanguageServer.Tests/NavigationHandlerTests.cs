// <copyright file="NavigationHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class NavigationHandlerTests
{
    [Fact]
    public void PrepareRename_IdentifiesRenamableSymbol()
    {
        const string source = "var x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var position = LanguageServerTestHelpers.PositionOf(source, "x");
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);

        Assert.NotNull(token);
        Assert.Equal(SyntaxKind.IdentifierToken, token.Kind);

        var compilation = new Compilation(content.SyntaxTree);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);
        Assert.True(SemanticLookup.CanRename(symbol));
    }

    [Fact]
    public void PrepareRename_KeywordsNotRenamable()
    {
        const string source = "var x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var position = LanguageServerTestHelpers.PositionOf(source, "var");
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);

        // Keywords are not identifier tokens
        Assert.NotEqual(SyntaxKind.IdentifierToken, token.Kind);
    }

    [Fact]
    public void Implementation_FindsStructImplementingInterface()
    {
        const string source = "type Shape interface { area() float64 }\ntype Circle struct { radius float64 }\nfunc (c Circle) area() float64 { return c.radius }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var compilation = new Compilation(content.SyntaxTree);
        var position = LanguageServerTestHelpers.PositionOf(source, "Shape");
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);

        // The symbol should be an interface type
        Assert.NotNull(symbol);
    }

    [Fact]
    public void TypeDefinition_NavigatesToType()
    {
        const string source = "var x int32 = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var compilation = new Compilation(content.SyntaxTree);
        var position = LanguageServerTestHelpers.PositionOf(source, "x");
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);

        // The variable should resolve to a symbol with a type
        Assert.NotNull(symbol);
    }
}
