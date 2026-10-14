// <copyright file="Issue711IfExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #711 / ADR-0064 — parser-level tests for `if` used as a
/// value-producing expression. Covers the shapes called out in the issue
/// scope: simple `if … else`, `else if` chains, nested forms, use in
/// let-init, use in argument position, use as the trailing expression of a
/// block, and the negative regressions that protect the if-statement form.
open class Issue711IfExpressionParserTests {
    @Fact
    func Parses_IfExpression_InLetInitializer() {
        const source = `package P
import System
let x = if true { 1 } else { 2 }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let ifExpr = FindFirst[IfExpressionSyntax](tree)
        Assert.NotNull(ifExpr.ElseKeyword)
        Assert.IsType[BlockExpressionSyntax](ifExpr.ThenBlock)
        Assert.IsType[BlockExpressionSyntax](ifExpr.ElseExpression)
        Assert.NotNull((cast[BlockExpressionSyntax](ifExpr.ThenBlock)).Expression)
        Assert.NotNull((cast[BlockExpressionSyntax](ifExpr.ElseExpression)).Expression)
    }

    @Fact
    func Parses_IfExpression_ElseIfChain_NestsRightAssociatively() {
        const source = "package P\nlet x = if 1 == 1 { \"a\" } else if 2 == 2 { \"b\" } else { \"c\" }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outerIf = FindFirst[IfExpressionSyntax](tree)
        Assert.NotNull(outerIf.ElseKeyword)
        let innerIf = Assert.IsType[IfExpressionSyntax](outerIf.ElseExpression)
        Assert.NotNull(innerIf.ElseKeyword)
        Assert.IsType[BlockExpressionSyntax](innerIf.ElseExpression)
    }

    @Fact
    func Parses_NestedIfExpression_InThenBranch() {
        const source = "package P\nlet x = if true { if false { 1 } else { 2 } } else { 3 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        // Both an outer and an inner IfExpression should be present.
        let ifs = Walk(tree.Root).OfType[IfExpressionSyntax]().ToList()
        Assert.Equal(2, ifs.Count)
    }

    @Fact
    func Parses_IfExpression_AsCallArgument() {
        const source = `package P
import System
Console.WriteLine(if true { "yes" } else { "no" })`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotNull(FindFirst[IfExpressionSyntax](tree))
    }

    @Fact
    func Parses_IfExpression_AsTrailingExpressionOfBlock() {
        const source = `package P
let x = if true {
    if false { 1 } else { 2 }
} else {
    3
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outerIf = FindFirst[IfExpressionSyntax](tree)
        let thenBlock = outerIf.ThenBlock
        // The then-block's trailing expression is the nested if-expression.
        Assert.IsType[IfExpressionSyntax](thenBlock.Expression)
        Assert.Empty(thenBlock.Statements)
    }

    @Fact
    func Parses_MultiStatementBlock_TrailingExpressionLifts() {
        const source = `package P
import System
let x = if true {
    Console.Write("")
    42
} else {
    0
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let ifExpr = FindFirst[IfExpressionSyntax](tree)
        let block = ifExpr.ThenBlock
        Assert.Single(block.Statements)
        Assert.NotNull(block.Expression)
    }

    @Fact
    func Parses_IfExpression_InReturnStatement() {
        const source = `package P
func Pick(b bool) int32 {
    return if b { 1 } else { -1 }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotNull(FindFirst[IfExpressionSyntax](tree))
    }

    @Fact
    func Parses_IfExpression_MissingElse_NoParseError_DeferredToBinder() {
        // Parser-side this still parses — diagnostic GS0276 is reported by
        // the binder at value position. The parser shape MUST not eat the
        // surrounding context.
        const source = "package P\nlet x = if true { 1 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let ifExpr = FindFirst[IfExpressionSyntax](tree)
        Assert.Null(ifExpr.ElseKeyword)
        Assert.Null(ifExpr.ElseExpression)
    }

    @Fact
    func Parses_IfStatement_StillWorks_WithoutElse() {
        // Regression guard for ADR-0064: existing if-statements with no else
        // continue to parse as if-statements (not if-expressions), and the
        // body of the if is a BlockStatementSyntax — not a BlockExpression.
        const source = `package P
import System
func F() {
    if true {
        Console.Write("x")
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let ifStmt = FindFirst[IfStatementSyntax](tree)
        Assert.IsType[BlockStatementSyntax](ifStmt.ThenStatement)
        Assert.Null(ifStmt.ElseClause)
    }

    @Fact
    func Parses_IfStatement_StillWorks_WithElseIfChain() {
        // Regression guard: an `if` used as a statement may still chain
        // through `else if` shapes that mirror the expression form.
        const source = `package P
import System
func F(n int32) {
    if n > 0 {
        Console.Write("p")
    } else if n < 0 {
        Console.Write("n")
    } else {
        Console.Write("z")
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfStatementSyntax](tree)
        Assert.NotNull(stmt.ElseClause)
    }

    @Fact
    func Parses_IfStatement_WithInitClause_Unchanged() {
        // Regression guard: the `if init; cond { … }` simple-statement form
        // is preserved by the statement path.
        const source = `package P
import System
func F() {
    if var x = 1; x > 0 {
        Console.Write("p")
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfStatementSyntax](tree)
        Assert.NotNull(stmt.Initializer)
        Assert.NotNull(stmt.Semicolon)
    }

    shared {
        private func FindFirst[T SyntaxNode](tree SyntaxTree) T {
            return Walk(tree.Root).OfType[T]().First()
        }

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for c in node.GetChildren() {
                if c is SyntaxNode sn {
                    for d in Walk(sn) {
                        yield d
                    }
                }
            }
        }
    }
}
