// <copyright file="DocumentationCommentLexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0057 §2: Tests that the lexer emits <see cref="SyntaxKind.DocumentationCommentToken"/>
/// with correct content and positional rules.
/// </summary>
public class DocumentationCommentLexerTests
{
    [Fact]
    public void TripleSlash_EmitsDocToken()
    {
        var tokens = SyntaxTree.ParseTokens("/// Hello");
        var doc = tokens.Single(t => t.Kind == SyntaxKind.DocumentationCommentToken);
        Assert.Equal("Hello", (string)doc.Value);
    }

    [Fact]
    public void TripleSlash_NoSpace_ContentStartsAtFourthChar()
    {
        var tokens = SyntaxTree.ParseTokens("///NoSpace");
        var doc = tokens.Single(t => t.Kind == SyntaxKind.DocumentationCommentToken);
        Assert.Equal("NoSpace", (string)doc.Value);
    }

    [Fact]
    public void FourSlashes_ContentIncludesExtraSlash()
    {
        // //// x → doc content is "/ x" (ADR §2: 4th slash is part of content)
        var tokens = SyntaxTree.ParseTokens("//// extra");
        var doc = tokens.Single(t => t.Kind == SyntaxKind.DocumentationCommentToken);
        Assert.Equal("/ extra", (string)doc.Value);
    }

    [Fact]
    public void TripleSlashEquals_ContentIsEquals()
    {
        // ///= x → content is "= x"
        var tokens = SyntaxTree.ParseTokens("///= x");
        var doc = tokens.Single(t => t.Kind == SyntaxKind.DocumentationCommentToken);
        Assert.Equal("= x", (string)doc.Value);
    }

    [Fact]
    public void BlankDocComment_EmptyContent()
    {
        // /// with nothing after it
        var tokens = SyntaxTree.ParseTokens("///");
        var doc = tokens.Single(t => t.Kind == SyntaxKind.DocumentationCommentToken);
        Assert.Equal(string.Empty, (string)doc.Value);
    }

    [Fact]
    public void DoubleSlash_StaysAsRegularComment()
    {
        var tokens = SyntaxTree.ParseTokens("// regular comment");
        Assert.DoesNotContain(tokens, t => t.Kind == SyntaxKind.DocumentationCommentToken);
        Assert.Contains(tokens, t => t.Kind == SyntaxKind.CommentToken);
    }

    [Fact]
    public void MultipleDocComments_OnSeparateLines()
    {
        var source = "/// Line one\n/// Line two";
        var tokens = SyntaxTree.ParseTokens(source);
        var docs = tokens.Where(t => t.Kind == SyntaxKind.DocumentationCommentToken).ToArray();
        Assert.Equal(2, docs.Length);
        Assert.Equal("Line one", (string)docs[0].Value);
        Assert.Equal("Line two", (string)docs[1].Value);
    }

    [Fact]
    public void DocCommentBeforeCode_DoesNotConsumeCode()
    {
        var source = "/// doc\nlet x = 1";
        var tokens = SyntaxTree.ParseTokens(source);
        Assert.Contains(tokens, t => t.Kind == SyntaxKind.DocumentationCommentToken);
        Assert.Contains(tokens, t => t.Kind == SyntaxKind.LetKeyword);
    }
}
