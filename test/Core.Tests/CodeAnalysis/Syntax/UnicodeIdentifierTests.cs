// <copyright file="UnicodeIdentifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Phase 1.7: identifiers follow Go's Unicode-letter rules.
/// <list type="bullet">
///   <item>Start: Unicode letter (categories Lu/Ll/Lt/Lm/Lo/Nl) or '_'.</item>
///   <item>Continue: Unicode letter, decimal digit (Nd), or '_'.</item>
/// </list>
/// .NET's <c>char.IsLetter</c> / <c>char.IsLetterOrDigit</c> are
/// Unicode-aware, so this is a verification + policy test set.
/// </summary>
public class UnicodeIdentifierTests
{
    [Theory]
    [InlineData("café")]
    [InlineData("π")]
    [InlineData("日本語")]
    [InlineData("Москва")]
    [InlineData("Δx")]
    [InlineData("naïve")]
    [InlineData("_underscore")]
    [InlineData("α2β")]
    public void Lexes_Unicode_Identifier_As_Single_Token(string identifier)
    {
        var tokens = SyntaxTree.ParseTokens(identifier).ToArray();

        Assert.Single(tokens);
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind);
        Assert.Equal(identifier, tokens[0].Text);
    }

    [Fact]
    public void Identifier_Cannot_Start_With_Digit()
    {
        var tokens = SyntaxTree.ParseTokens("2π").ToArray();
        Assert.Equal(2, tokens.Length);
        Assert.Equal(SyntaxKind.NumberToken, tokens[0].Kind);
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[1].Kind);
        Assert.Equal("π", tokens[1].Text);
    }

    [Fact]
    public void Unicode_Identifier_Binds_Correctly()
    {
        var source = "func F() {\n let π = 3\n let twoπ = π + π\n }\n";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
