// <copyright file="Issue1038StandaloneRangeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1038: parser-level coverage for the standalone range expression
/// `lo..hi` (and the open forms `..hi`, `lo..`, `..`) that
/// produces a `System.Range` value outside of an index bracket. The `..`
/// operator binds looser than every binary operator, so `1+2..3+4` parses as
/// `(1+2)..(3+4)`; a from-end `^n` marker is recognised in the upper
/// bound (`lo..^hi`).
open class Issue1038StandaloneRangeParserTests {
    @Fact
    func Parses_StandaloneClosedRange() {
        let range_ = GetInitializerRange("package P\nlet r = 1..3")
        Assert.NotNull(range_.LowerBound)
        Assert.NotNull(range_.UpperBound)
        Assert.Equal(SyntaxKind.DotDotToken, range_.DotDotToken.Kind)
    }

    @Fact
    func Parses_StandaloneOpenLowerBound() {
        let range_ = GetInitializerRange("package P\nlet r = ..3")
        Assert.Null(range_.LowerBound)
        Assert.NotNull(range_.UpperBound)
    }

    @Fact
    func Parses_StandaloneOpenUpperBound() {
        let range_ = GetInitializerRange("package P\nlet r = 1..")
        Assert.NotNull(range_.LowerBound)
        Assert.Null(range_.UpperBound)
    }

    @Fact
    func Parses_StandaloneFullyOpenRange() {
        let range_ = GetInitializerRange("package P\nlet r = ..")
        Assert.Null(range_.LowerBound)
        Assert.Null(range_.UpperBound)
    }

    @Fact
    func RangeBindsLooserThanAdditive() {
        // `1+2..3+4` must parse as `(1+2)..(3+4)`: each bound is the whole
        // additive expression, not just the adjacent operand.
        let range_ = GetInitializerRange("package P\nlet r = 1+2..3+4")
        Assert.IsType[BinaryExpressionSyntax](range_.LowerBound)
        Assert.IsType[BinaryExpressionSyntax](range_.UpperBound)
    }

    @Fact
    func Parses_FromEndUpperBound() {
        let range_ = GetInitializerRange("package P\nlet r = 1..^1")
        Assert.NotNull(range_.LowerBound)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.UpperBound)
    }

    @Fact
    func Parses_FromEndUpperBound_OpenLower() {
        let range_ = GetInitializerRange("package P\nlet r = ..^2")
        Assert.Null(range_.LowerBound)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.UpperBound)
    }

    @Fact
    func OpenUpperBound_StopsAtNewline() {
        // A line break after `..` terminates the open range rather than
        // absorbing the next statement as the upper bound.
        let tree = SyntaxTree.Parse(`package P
let r = 1..
let s = 5`)
        Assert.Empty(tree.Diagnostics)
        let decls = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .ToList()
        Assert.Equal(2, decls.Count)
        let range_ = Assert.IsType[RangeExpressionSyntax](decls[0].Initializer)
        Assert.NotNull(range_.LowerBound)
        Assert.Null(range_.UpperBound)
    }

    @Fact
    func IndexRange_StillParsesInsideBrackets() {
        // The index-bracket range path (#1016/#1022) is unchanged: `a[^2..]`
        // is a RangeExpression whose lower bound is a from-end marker.
        let tree = SyntaxTree.Parse("package P\nlet x = a[^2..]")
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let index = Assert.IsType[IndexExpressionSyntax](stmt.Initializer)
        let range_ = Assert.IsType[RangeExpressionSyntax](index.Index)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.LowerBound)
        Assert.Null(range_.UpperBound)
    }

    @Fact
    func ParenthesizedRange_InsideIndexBracket() {
        // `a[(1..3)]` is an ordinary index whose argument is a parenthesised
        // standalone range value (NOT a syntactic index-range).
        let tree = SyntaxTree.Parse("package P\nlet x = a[(1..3)]")
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let index = Assert.IsType[IndexExpressionSyntax](stmt.Initializer)
        let paren = Assert.IsType[ParenthesizedExpressionSyntax](index.Index)
        Assert.IsType[RangeExpressionSyntax](paren.Expression)
    }

    shared {
        private func GetInitializerRange(source string) RangeExpressionSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let stmt = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return Assert.IsType[RangeExpressionSyntax](stmt.Initializer)
        }
    }
}
