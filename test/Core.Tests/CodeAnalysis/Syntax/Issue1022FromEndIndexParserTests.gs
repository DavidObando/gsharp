// <copyright file="Issue1022FromEndIndexParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1022: parser-level coverage for the from-end index marker `^n`.
/// In the leading position of an index/range bound the hat token introduces a
/// (cref:FromEndIndexExpressionSyntax) (`a[^1]`, `a[1..^1]`,
/// `a[^2..]`); since ADR-0187 prefix `^` is a from-end Index
/// everywhere and binary `^` is XOR.
open class Issue1022FromEndIndexParserTests {
    @Fact
    func SingleFromEndIndex_ParsesAsFromEndMarker() {
        let index = Assert.IsType[IndexExpressionSyntax](GetInitializer("package P\nlet x = a[^1]"))
        let fromEnd = Assert.IsType[FromEndIndexExpressionSyntax](index.Index)
        Assert.Equal(SyntaxKind.HatToken, fromEnd.HatToken.Kind)
        Assert.IsType[LiteralExpressionSyntax](fromEnd.Operand)
    }

    @Fact
    func FromEndUpperBound_InClosedRange() {
        let index = Assert.IsType[IndexExpressionSyntax](GetInitializer("package P\nlet x = a[1..^1]"))
        let range_ = Assert.IsType[RangeExpressionSyntax](index.Index)
        Assert.IsType[LiteralExpressionSyntax](range_.LowerBound)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.UpperBound)
    }

    @Fact
    func FromEndUpperBound_InOpenLowerRange() {
        let index = Assert.IsType[IndexExpressionSyntax](GetInitializer("package P\nlet x = a[..^3]"))
        let range_ = Assert.IsType[RangeExpressionSyntax](index.Index)
        Assert.Null(range_.LowerBound)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.UpperBound)
    }

    @Fact
    func FromEndLowerBound_InOpenUpperRange() {
        let index = Assert.IsType[IndexExpressionSyntax](GetInitializer("package P\nlet x = a[^2..]"))
        let range_ = Assert.IsType[RangeExpressionSyntax](index.Index)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.LowerBound)
        Assert.Null(range_.UpperBound)
    }

    @Fact
    func FromEnd_BothBounds() {
        let index = Assert.IsType[IndexExpressionSyntax](GetInitializer("package P\nlet x = a[^3..^1]"))
        let range_ = Assert.IsType[RangeExpressionSyntax](index.Index)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.LowerBound)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.UpperBound)
    }

    @Fact
    func PrefixHat_OutsideBrackets_IsFromEndIndex_Adr0187() {
        // ADR-0187: prefix `^` is a first-class from-end Index everywhere.
        let fromEnd = Assert.IsType[FromEndIndexExpressionSyntax](GetInitializer("package P\nlet x = ^5"))
        Assert.IsType[LiteralExpressionSyntax](fromEnd.Operand)
    }

    @Fact
    func Xor_Binary_StillParsesInsideBrackets() {
        // A non-leading `^` inside the bracket is the binary XOR operator, not a
        // from-end marker.
        let index = Assert.IsType[IndexExpressionSyntax](GetInitializer("package P\nlet x = a[i ^ j]"))
        Assert.IsType[BinaryExpressionSyntax](index.Index)
    }

    shared {
        private func GetInitializer(source string) ExpressionSyntax? {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let stmt = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return stmt.Initializer
        }
    }
}
