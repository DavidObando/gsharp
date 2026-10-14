// <copyright file="Issue709NullCoalescingAssignmentLexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #709 / ADR-0072: lexer-level coverage for the new `??=`
/// null-coalescing compound assignment operator. The doubled-question-mark
/// is recognized only as part of the three-character `??=` sequence —
/// the bare `?`, the `??`-null-coalescing-read, and the
/// existing `?.`-safe-navigation tokens must keep their meaning.
open class Issue709NullCoalescingAssignmentLexerTests {
    @Fact
    func Lexes_QuestionQuestionEquals_AsSingleToken() {
        let tokens = SyntaxTree.ParseTokens("??=").ToList()
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, tokens[0].Kind)
        Assert.Equal("??=", tokens[0].Text)
    }

    @Fact
    func Lexes_QuestionQuestion_AsSingleToken() {
        // Issue #941: bare `??` is the null-coalescing read operator.
        let tokens = SyntaxTree.ParseTokens("??").ToList()
        Assert.Equal(SyntaxKind.QuestionQuestionToken, tokens[0].Kind)
        Assert.Equal("??", tokens[0].Text)
    }

    @Fact
    func Lexes_QuestionColon_AsSeparateTokens() {
        // Issue #941: `?:` was removed. It now lexes as a `?` followed by a
        // separate `:` (no longer a single QuestionColonToken).
        let tokens = SyntaxTree.ParseTokens("?:").ToList()
        Assert.Equal(SyntaxKind.QuestionToken, tokens[0].Kind)
        Assert.Equal(SyntaxKind.ColonToken, tokens[1].Kind)
    }

    @Fact
    func Lexes_QuestionDot_AsSafeNavigation() {
        let tokens = SyntaxTree.ParseTokens("?.").ToList()
        Assert.Equal(SyntaxKind.QuestionDotToken, tokens[0].Kind)
        Assert.Equal("?.", tokens[0].Text)
    }

    @Fact
    func Lexes_BareQuestion_AsQuestionToken() {
        // Type-annotation use: `string?` — the bare `?` must not be greedily
        // consumed by the new compound-assignment lexer branch.
        let tokens = SyntaxTree.ParseTokens("string?").ToList()
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind)
        Assert.Equal("string", tokens[0].Text)
        Assert.Equal(SyntaxKind.QuestionToken, tokens[1].Kind)
        Assert.Equal("?", tokens[1].Text)
    }

    @Fact
    func Lexes_QuestionQuestionWithoutEquals_AsNullCoalescingToken() {
        // Per issue #941, bare `??` is the binary null-coalescing operator and
        // lexes as a single QuestionQuestionToken (distinct from the `??=`
        // compound-assignment token).
        let tokens = SyntaxTree.ParseTokens("??").ToList()
        Assert.Equal(SyntaxKind.QuestionQuestionToken, tokens[0].Kind)
        Assert.Equal("??", tokens[0].Text)
    }

    @Fact
    func Lexes_QuestionQuestionEquals_InStatementContext() {
        const source = "x ??= y"
        let tokens = SyntaxTree
            .ParseTokens(source)
            .Where((t SyntaxToken) -> t.Kind != SyntaxKind.WhitespaceToken)
            .ToList()
        // Identifier, ??=, Identifier, EndOfFile.
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind)
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, tokens[1].Kind)
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[2].Kind)
    }

    @Fact
    func SyntaxFacts_GetText_RoundTrip() {
        Assert.Equal("??=", SyntaxFacts.GetText(SyntaxKind.QuestionQuestionEqualsToken))
    }
}
