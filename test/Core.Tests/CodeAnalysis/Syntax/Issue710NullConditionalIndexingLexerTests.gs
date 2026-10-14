// <copyright file="Issue710NullConditionalIndexingLexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #710 / ADR-0073: lexer-level coverage for the new `?[`
/// null-conditional indexing prefix. The token is recognised only when
/// `[` immediately follows `?` with no intervening trivia — so
/// the existing `?.`, `??`, `??=`, and bare-`?`
/// (type-annotation) tokens keep their meanings, and a true ternary
/// `cond ? [arr] : [arr]` (with whitespace separating `?` and
/// `[`) keeps lexing as two tokens.
open class Issue710NullConditionalIndexingLexerTests {
    @Fact
    func Lexes_QuestionOpenBracket_AsSingleToken() {
        let tokens = SyntaxTree.ParseTokens("?[").ToList()
        Assert.Equal(SyntaxKind.QuestionOpenBracketToken, tokens[0].Kind)
        Assert.Equal("?[", tokens[0].Text)
    }

    @Fact
    func Lexes_QuestionOpenBracket_InIndexContext() {
        const source = "a?[i]"
        let tokens = SyntaxTree
            .ParseTokens(source)
            .Where((t SyntaxToken) -> t.Kind != SyntaxKind.WhitespaceToken)
            .ToList()
        // Identifier, ?[, Identifier, ], EndOfFile.
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind)
        Assert.Equal(SyntaxKind.QuestionOpenBracketToken, tokens[1].Kind)
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[2].Kind)
        Assert.Equal(SyntaxKind.CloseSquareBracketToken, tokens[3].Kind)
    }

    @Fact
    func DoesNotLexQuestionOpenBracket_WhenWhitespaceSeparates() {
        // `?` then space then `[` must remain two tokens so the ternary
        // form `cond ? [arr] : [arr]` keeps working unchanged.
        let tokens = SyntaxTree
            .ParseTokens("? [")
            .Where((t SyntaxToken) -> t.Kind != SyntaxKind.WhitespaceToken)
            .ToList()
        Assert.Equal(SyntaxKind.QuestionToken, tokens[0].Kind)
        Assert.Equal(SyntaxKind.OpenSquareBracketToken, tokens[1].Kind)
    }

    @Fact
    func Lexes_QuestionDot_StillAsSafeNavigation() {
        let tokens = SyntaxTree.ParseTokens("?.").ToList()
        Assert.Equal(SyntaxKind.QuestionDotToken, tokens[0].Kind)
    }

    @Fact
    func Lexes_QuestionQuestion_AsNullCoalescingRead() {
        // Issue #941: `??` is the null-coalescing read operator (formerly `?:`).
        let tokens = SyntaxTree.ParseTokens("??").ToList()
        Assert.Equal(SyntaxKind.QuestionQuestionToken, tokens[0].Kind)
    }

    @Fact
    func Lexes_QuestionQuestionEquals_StillAsNullCoalescingAssignment() {
        let tokens = SyntaxTree.ParseTokens("??=").ToList()
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, tokens[0].Kind)
    }

    @Fact
    func Lexes_BareQuestion_StillAsQuestionToken() {
        // Nullable-type-annotation use: `string?`. Must NOT be consumed
        // as part of the new `?[` token even when the next character is
        // a `[` separated by an intervening identifier boundary.
        let tokens = SyntaxTree
            .ParseTokens("string?")
            .Where((t SyntaxToken) -> t.Kind != SyntaxKind.WhitespaceToken)
            .ToList()
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind)
        Assert.Equal(SyntaxKind.QuestionToken, tokens[1].Kind)
    }

    @Fact
    func SyntaxFacts_GetText_RoundTrip() {
        Assert.Equal("?[", SyntaxFacts.GetText(SyntaxKind.QuestionOpenBracketToken))
    }
}
