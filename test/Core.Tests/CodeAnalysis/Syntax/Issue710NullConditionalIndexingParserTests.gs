// <copyright file="Issue710NullConditionalIndexingParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #710 / ADR-0073: parser-level coverage for the new `a?[i]`
/// null-conditional indexing form. The parser produces an
/// (cref:IndexExpressionSyntax) whose `OpenBracketToken.Kind`
/// is (cref:SyntaxKind.QuestionOpenBracketToken) and whose
/// (cref:IndexExpressionSyntax.IsNullConditional) is `true`.
open class Issue710NullConditionalIndexingParserTests {
    @Fact
    func Parses_BareIdentifierTarget_AsNullConditionalIndex() {
        const source = "package P\nvar x = a?[i]"
        let index = GetTopLevelIndex(source)
        Assert.True(index.IsNullConditional)
        Assert.Equal(SyntaxKind.QuestionOpenBracketToken, index.OpenBracketToken.Kind)
        Assert.IsType[NameExpressionSyntax](index.Target)
        Assert.IsType[NameExpressionSyntax](index.Index)
    }

    @Fact
    func Parses_StringIndex_AsNullConditionalIndex() {
        const source = "package P\nvar x = d?[\"k\"]"
        let index = GetTopLevelIndex(source)
        Assert.True(index.IsNullConditional)
        Assert.IsType[LiteralExpressionSyntax](index.Index)
    }

    @Fact
    func Parses_PlainIndex_AsNotNullConditional() {
        const source = "package P\nvar x = a[i]"
        let index = GetTopLevelIndex(source)
        Assert.False(index.IsNullConditional)
        Assert.Equal(SyntaxKind.OpenSquareBracketToken, index.OpenBracketToken.Kind)
    }

    @Fact
    func Parses_ChainedAccess_RightOfDotNullConditional() {
        // `a.b?[i]` parses as an Accessor(a, ., IndexExpression(b, ?[, i)).
        const source = "package P\nvar x = a.b?[i]"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let outerAccessor = Assert.IsType[AccessorExpressionSyntax](stmt.Initializer)
        Assert.False(outerAccessor.IsNullConditional)
        let inner = Assert.IsType[IndexExpressionSyntax](outerAccessor.RightPart)
        Assert.True(inner.IsNullConditional)
    }

    @Fact
    func Parses_ChainedNullConditionalThenIndex() {
        // `a?.b?[i]` — outer ?., inner ?[].
        const source = "package P\nvar x = a?.b?[i]"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let outerAccessor = Assert.IsType[AccessorExpressionSyntax](stmt.Initializer)
        Assert.True(outerAccessor.IsNullConditional)
        let inner = Assert.IsType[IndexExpressionSyntax](outerAccessor.RightPart)
        Assert.True(inner.IsNullConditional)
    }

    @Fact
    func Parses_DoubleNullConditionalIndex() {
        // `a?[i]?[j]` — outer wrap is an IndexExpression with IsNullConditional
        // whose Target is itself an IndexExpression with IsNullConditional.
        const source = "package P\nvar x = a?[i]?[j]"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let outer = Assert.IsType[IndexExpressionSyntax](stmt.Initializer)
        Assert.True(outer.IsNullConditional)
        let inner = Assert.IsType[IndexExpressionSyntax](outer.Target)
        Assert.True(inner.IsNullConditional)
    }

    @Fact
    func Parses_TernaryWithBracketedExpressionStillWorks() {
        // Regression: `cond ? then : else` MUST still parse as a ternary
        // even when the branches start with `[`. The lexer keeps `?` and
        // `[` as two tokens whenever they are separated by trivia, so
        // ternary forms remain unambiguous.
        const source = "package P\nvar x = (true) ? 1 : 2"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Parses_PostfixChainContinuesAfterNullConditionalIndex() {
        // `a?[i]?.b` — null-conditional index, then null-conditional member.
        const source = "package P\nvar x = a?[i]?.b"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let outerAccessor = Assert.IsType[AccessorExpressionSyntax](stmt.Initializer)
        Assert.True(outerAccessor.IsNullConditional)
        let index = Assert.IsType[IndexExpressionSyntax](outerAccessor.LeftPart)
        Assert.True(index.IsNullConditional)
    }

    shared {
        private func GetTopLevelIndex(source string) IndexExpressionSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let stmt = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return Assert.IsType[IndexExpressionSyntax](stmt.Initializer)
        }
    }
}
