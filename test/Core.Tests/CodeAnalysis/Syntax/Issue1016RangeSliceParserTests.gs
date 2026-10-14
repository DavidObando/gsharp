// <copyright file="Issue1016RangeSliceParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1016: parser-level coverage for the range/slice operator `..`
/// inside an indexer. `a[lo..hi]` parses as an
/// (cref:IndexExpressionSyntax) whose index operand is a
/// (cref:RangeExpressionSyntax), with each bound optional for the open
/// forms (`a[..hi]`, `a[lo..]`, `a[..]`).
open class Issue1016RangeSliceParserTests {
    @Fact
    func Parses_ClosedRange_WithBothBounds() {
        let range_ = GetTopLevelRange("package P\nlet x = a[1..3]")
        Assert.NotNull(range_.LowerBound)
        Assert.NotNull(range_.UpperBound)
        Assert.Equal(SyntaxKind.DotDotToken, range_.DotDotToken.Kind)
    }

    @Fact
    func Parses_OpenLowerBound() {
        let range_ = GetTopLevelRange("package P\nlet x = a[..3]")
        Assert.Null(range_.LowerBound)
        Assert.NotNull(range_.UpperBound)
    }

    @Fact
    func Parses_OpenUpperBound() {
        let range_ = GetTopLevelRange("package P\nlet x = a[1..]")
        Assert.NotNull(range_.LowerBound)
        Assert.Null(range_.UpperBound)
    }

    @Fact
    func Parses_FullyOpenRange() {
        let range_ = GetTopLevelRange("package P\nlet x = a[..]")
        Assert.Null(range_.LowerBound)
        Assert.Null(range_.UpperBound)
    }

    @Fact
    func Parses_ExpressionBounds() {
        let range_ = GetTopLevelRange("package P\nlet x = a[i + 1..n - 1]")
        Assert.IsType[BinaryExpressionSyntax](range_.LowerBound)
        Assert.IsType[BinaryExpressionSyntax](range_.UpperBound)
    }

    @Fact
    func PlainIndex_IsNotARange() {
        let tree = SyntaxTree.Parse("package P\nlet x = a[2]")
        Assert.Empty(tree.Diagnostics)
        let stmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let index = Assert.IsType[IndexExpressionSyntax](stmt.Initializer)
        Assert.IsNotType[RangeExpressionSyntax](index.Index)
    }

    @Fact
    func Ellipsis_StillLexesDistinctlyFromDotDot() {
        // `...` must remain a single EllipsisToken, not `..` + `.`.
        let tokens = SyntaxTree.ParseTokens("...").ToArray()
        let token = Assert.Single(tokens)
        Assert.Equal(SyntaxKind.EllipsisToken, token.Kind)
    }

    shared {
        private func GetTopLevelRange(source string) RangeExpressionSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let stmt = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            let index = Assert.IsType[IndexExpressionSyntax](stmt.Initializer)
            return Assert.IsType[RangeExpressionSyntax](index.Index)
        }
    }
}
