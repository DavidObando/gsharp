// <copyright file="Issue709NullCoalescingAssignmentLexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #709 / ADR-0072: lexer-level coverage for the new <c>??=</c>
/// null-coalescing compound assignment operator. The doubled-question-mark
/// is recognized only as part of the three-character <c>??=</c> sequence —
/// the bare <c>?</c>, the existing <c>?:</c>-null-coalescing-read, and the
/// existing <c>?.</c>-safe-navigation tokens must keep their meaning.
/// </summary>
public class Issue709NullCoalescingAssignmentLexerTests
{
    [Fact]
    public void Lexes_QuestionQuestionEquals_AsSingleToken()
    {
        var tokens = SyntaxTree.ParseTokens("??=").ToList();
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, tokens[0].Kind);
        Assert.Equal("??=", tokens[0].Text);
    }

    [Fact]
    public void Lexes_QuestionColon_AsSeparateTokens()
    {
        var tokens = SyntaxTree.ParseTokens("?:").ToList();
        Assert.Equal(SyntaxKind.QuestionColonToken, tokens[0].Kind);
        Assert.Equal("?:", tokens[0].Text);
    }

    [Fact]
    public void Lexes_QuestionDot_AsSafeNavigation()
    {
        var tokens = SyntaxTree.ParseTokens("?.").ToList();
        Assert.Equal(SyntaxKind.QuestionDotToken, tokens[0].Kind);
        Assert.Equal("?.", tokens[0].Text);
    }

    [Fact]
    public void Lexes_BareQuestion_AsQuestionToken()
    {
        // Type-annotation use: `string?` — the bare `?` must not be greedily
        // consumed by the new compound-assignment lexer branch.
        var tokens = SyntaxTree.ParseTokens("string?").ToList();
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind);
        Assert.Equal("string", tokens[0].Text);
        Assert.Equal(SyntaxKind.QuestionToken, tokens[1].Kind);
        Assert.Equal("?", tokens[1].Text);
    }

    [Fact]
    public void Lexes_QuestionQuestionWithoutEquals_AsTwoQuestionTokens()
    {
        // G# does not introduce a bare `??` token — it falls back to two
        // separate `?` tokens (which the parser will reject in any context
        // that does not expect them, but the lexer must not synthesize a
        // new token kind for the two-character sequence).
        var tokens = SyntaxTree.ParseTokens("??").ToList();
        Assert.Equal(SyntaxKind.QuestionToken, tokens[0].Kind);
        Assert.Equal(SyntaxKind.QuestionToken, tokens[1].Kind);
    }

    [Fact]
    public void Lexes_QuestionQuestionEquals_InStatementContext()
    {
        const string source = "x ??= y";
        var tokens = SyntaxTree.ParseTokens(source)
            .Where(t => t.Kind != SyntaxKind.WhitespaceToken)
            .ToList();

        // Identifier, ??=, Identifier, EndOfFile.
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind);
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, tokens[1].Kind);
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[2].Kind);
    }

    [Fact]
    public void SyntaxFacts_GetText_RoundTrip()
    {
        Assert.Equal("??=", SyntaxFacts.GetText(SyntaxKind.QuestionQuestionEqualsToken));
    }
}
