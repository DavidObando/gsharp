// <copyright file="Issue1930DeferExpressionOnlyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1930: the cs2gs code model/printer used to emit `defer { … }`
/// (a block body) while `Parser.ParseDeferStatement` only ever accepted
/// a single expression operand, per ADR-0030 ("Add `defer call(arg1,
/// arg2, …)` as a statement"). The fix keeps the parser as the source of
/// truth — a single call-expression operand — and updates the cs2gs code
/// model/printer to match instead of teaching the parser a statement-body
/// form. Issue #3355 later made a trailing-value block an expression in its
/// own right; that remains within defer's expression-only contract.
open class Issue1930DeferExpressionOnlyParserTests {
    @Fact
    func Parses_DeferWithCallExpression() {
        const source = `package P
func cleanup() { }
{
    defer cleanup()
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let deferStmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[BlockStatementSyntax]()
            .SelectMany(
            func (b BlockStatementSyntax) IEnumerable[StatementSyntax] {
                return b.Statements
            }
        )
            .OfType[DeferStatementSyntax]()
            .Single()
        Assert.Equal(SyntaxKind.DeferKeyword, deferStmt.DeferKeyword.Kind)
        Assert.IsType[CallExpressionSyntax](deferStmt.Expression)
    }

    @Fact
    func Parses_DeferWithBlockExpressionOperand() {
        const source = `package P
{
    defer {
        let value = cleanup()
        value
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let deferStmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[BlockStatementSyntax]()
            .SelectMany(
            func (b BlockStatementSyntax) IEnumerable[StatementSyntax] {
                return b.Statements
            }
        )
            .OfType[DeferStatementSyntax]()
            .Single()
        Assert.IsType[BlockExpressionSyntax](deferStmt.Expression)
    }
}
