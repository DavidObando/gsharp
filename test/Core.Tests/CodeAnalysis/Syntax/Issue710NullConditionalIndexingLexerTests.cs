// <copyright file="Issue710NullConditionalIndexingLexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #710 / ADR-0073: lexer-level coverage for the new <c>?[</c>
/// null-conditional indexing prefix. The token is recognised only when
/// <c>[</c> immediately follows <c>?</c> with no intervening trivia — so
/// the existing <c>?.</c>, <c>?:</c>, <c>??=</c>, and bare-<c>?</c>
/// (type-annotation) tokens keep their meanings, and a true ternary
/// <c>cond ? [arr] : [arr]</c> (with whitespace separating <c>?</c> and
/// <c>[</c>) keeps lexing as two tokens.
/// </summary>
public class Issue710NullConditionalIndexingLexerTests
{
    [Fact]
    public void Lexes_QuestionOpenBracket_AsSingleToken()
    {
        var tokens = SyntaxTree.ParseTokens("?[").ToList();
        Assert.Equal(SyntaxKind.QuestionOpenBracketToken, tokens[0].Kind);
        Assert.Equal("?[", tokens[0].Text);
    }

    [Fact]
    public void Lexes_QuestionOpenBracket_InIndexContext()
    {
        const string source = "a?[i]";
        var tokens = SyntaxTree.ParseTokens(source)
            .Where(t => t.Kind != SyntaxKind.WhitespaceToken)
            .ToList();

        // Identifier, ?[, Identifier, ], EndOfFile.
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind);
        Assert.Equal(SyntaxKind.QuestionOpenBracketToken, tokens[1].Kind);
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[2].Kind);
        Assert.Equal(SyntaxKind.CloseSquareBracketToken, tokens[3].Kind);
    }

    [Fact]
    public void DoesNotLexQuestionOpenBracket_WhenWhitespaceSeparates()
    {
        // `?` then space then `[` must remain two tokens so the ternary
        // form `cond ? [arr] : [arr]` keeps working unchanged.
        var tokens = SyntaxTree.ParseTokens("? [")
            .Where(t => t.Kind != SyntaxKind.WhitespaceToken)
            .ToList();

        Assert.Equal(SyntaxKind.QuestionToken, tokens[0].Kind);
        Assert.Equal(SyntaxKind.OpenSquareBracketToken, tokens[1].Kind);
    }

    [Fact]
    public void Lexes_QuestionDot_StillAsSafeNavigation()
    {
        var tokens = SyntaxTree.ParseTokens("?.").ToList();
        Assert.Equal(SyntaxKind.QuestionDotToken, tokens[0].Kind);
    }

    [Fact]
    public void Lexes_QuestionColon_StillAsNullCoalescingRead()
    {
        var tokens = SyntaxTree.ParseTokens("?:").ToList();
        Assert.Equal(SyntaxKind.QuestionColonToken, tokens[0].Kind);
    }

    [Fact]
    public void Lexes_QuestionQuestionEquals_StillAsNullCoalescingAssignment()
    {
        var tokens = SyntaxTree.ParseTokens("??=").ToList();
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, tokens[0].Kind);
    }

    [Fact]
    public void Lexes_BareQuestion_StillAsQuestionToken()
    {
        // Nullable-type-annotation use: `string?`. Must NOT be consumed
        // as part of the new `?[` token even when the next character is
        // a `[` separated by an intervening identifier boundary.
        var tokens = SyntaxTree.ParseTokens("string?")
            .Where(t => t.Kind != SyntaxKind.WhitespaceToken)
            .ToList();

        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind);
        Assert.Equal(SyntaxKind.QuestionToken, tokens[1].Kind);
    }

    [Fact]
    public void SyntaxFacts_GetText_RoundTrip()
    {
        Assert.Equal("?[", SyntaxFacts.GetText(SyntaxKind.QuestionOpenBracketToken));
    }
}
