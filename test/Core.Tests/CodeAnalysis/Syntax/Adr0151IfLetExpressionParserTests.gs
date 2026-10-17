// <copyright file="Adr0151IfLetExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0151 — parser coverage for `if let` used as a value-producing
/// expression: single and multiple bindings, the optional top-level
/// `&&` guard and its parenthesization escape hatch, explicit
/// type clauses, `else if` / `else if let` chaining, recovery for
/// missing pieces, and the regressions that protect the ADR-0071 STATEMENT
/// forms.
open class Adr0151IfLetExpressionParserTests {
    @Fact
    func Parses_IfLetExpression_InLetInitializer() {
        const source = `package P
func F(s string?) string {
    let v = if let x = s { x } else { "none" }
    return v
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        Assert.Equal(1, expr.Bindings.Count)
        Assert.Equal("x", expr.Bindings[0].Identifier.Text)
        Assert.Null(expr.AmpersandAmpersandToken)
        Assert.Null(expr.Guard)
        Assert.NotNull(expr.ElseKeyword)
        Assert.IsType[BlockExpressionSyntax](expr.ElseExpression)
        Assert.NotNull(expr.ThenBlock.Expression)
        Assert.NotNull((cast[BlockExpressionSyntax](expr.ElseExpression)).Expression)
    }

    @Fact
    func Parses_TopLevelAmpersandAmpersand_AsGuard_NotAsInitializerOperand() {
        // The user-selected grammar example: the `&&` after the (single)
        // initializer starts the guard, so the initializer is exactly
        // `GetCopyrights()`.
        const source = `package P
func F() string? {
    return if let copyright = GetCopyrights() && copyright.Length > 0 {
        copyright[0]
    } else {
        default(string?)
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        Assert.NotNull(expr.AmpersandAmpersandToken)
        Assert.Equal(SyntaxKind.AmpersandAmpersandToken, expr.AmpersandAmpersandToken!!.Kind)
        Assert.NotNull(expr.Guard)
        // The initializer is the bare call — no `&&` was folded into it.
        let initializer = expr.Bindings[0].Initializer
        Assert.IsNotType[BinaryExpressionSyntax](initializer)
        // The guard is the comparison, not a conjunction.
        let guard_ = Assert.IsType[BinaryExpressionSyntax](expr.Guard)
        Assert.Equal(SyntaxKind.GreaterToken, guard_.OperatorToken.Kind)
    }

    @Fact
    func Parses_MultipleBindings_ThenOptionalGuard() {
        const source = `package P
func F(a string?, b string?) string {
    return if let x = a, let y = b && x.Length > 0 { y } else { "none" }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        Assert.Equal(2, expr.Bindings.Count)
        Assert.Equal("x", expr.Bindings[0].Identifier.Text)
        Assert.Equal("y", expr.Bindings[1].Identifier.Text)
        Assert.NotNull(expr.Guard)
    }

    @Fact
    func Parses_ParenthesizedLogicalAnd_AsInitializer_NotAsGuardDelimiter() {
        // The escape hatch documented in ADR-0151: a logical-and that really
        // belongs to the initializer is parenthesized, so the `&&` that
        // FOLLOWS it is still the guard delimiter.
        const source = `package P
func F(a bool, b bool, c bool) bool {
    return if let ok = (a && b) && c { ok } else { false }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        Assert.NotNull(expr.Guard)
        Assert.Equal("c", Assert.IsType[NameExpressionSyntax](expr.Guard).IdentifierToken.Text)
        Assert.IsType[ParenthesizedExpressionSyntax](expr.Bindings[0].Initializer)
    }

    @Fact
    func Parses_ExplicitUnderlyingTypeClause() {
        const source = `package P
func F(s string?) string {
    return if let v string = s { v } else { "none" }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        Assert.NotNull(expr.Bindings[0].TypeClause)
    }

    @Fact
    func Parses_ElseIfLetChain_NestsRightAssociatively() {
        const source = `package P
func F(a string?, b string?) string {
    return if let x = a { x } else if let y = b { y } else { "none" }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = FindFirst[IfLetExpressionSyntax](tree)
        let inner = Assert.IsType[IfLetExpressionSyntax](outer.ElseExpression)
        Assert.IsType[BlockExpressionSyntax](inner.ElseExpression)
    }

    @Fact
    func Parses_PlainIfExpression_ChainingIntoIfLet() {
        const source = `package P
func F(flag bool, a string?) string {
    return if flag { "flag" } else if let x = a { x } else { "none" }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = FindFirst[IfExpressionSyntax](tree)
        Assert.IsType[IfLetExpressionSyntax](outer.ElseExpression)
    }

    @Fact
    func Parses_NestedIfLetExpression_AsTrailingValueOfBranchBlock() {
        const source = `package P
func F(flag bool, a string?) string {
    return if flag {
        if let x = a { x } else { "inner" }
    } else {
        "outer"
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = FindFirst[IfExpressionSyntax](tree)
        Assert.IsType[IfLetExpressionSyntax](outer.ThenBlock.Expression)
    }

    @Fact
    func Parses_IfLetExpression_InArgumentPosition() {
        const source = `package P
import System
func F(a string?) {
    Console.WriteLine(if let x = a { x } else { "none" })
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotNull(FindFirst[IfLetExpressionSyntax](tree))
    }

    @Fact
    func MissingInitializer_Recovers_WithDiagnostic() {
        const source = `package P
func F(a string?) string {
    return if let x = { x } else { "none" }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }

    @Fact
    func MissingGuardExpression_Recovers_WithDiagnostic() {
        const source = `package P
func F(a string?) string {
    return if let x = a && { x } else { "none" }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }

    @Fact
    func MissingElse_Parses_WithNullElseForTheBinderToReject() {
        // The parser does not manufacture an `else` (that would cascade into a
        // bogus block parse); the binder reports GS0276 for the null else,
        // exactly as it does for the ADR-0064 if-expression.
        const source = `package P
func F(a string?) string {
    return if let x = a { x }
}`
        let tree = SyntaxTree.Parse(source)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        Assert.Null(expr.ElseKeyword)
        Assert.Null(expr.ElseExpression)
    }

    @Fact
    func StatementForm_IfLet_StillParsesAsStatement() {
        // Regression guard for ADR-0071: a statement-leading `if let` is still
        // an IfLetStatementSyntax even when it has a plain terminal `else`.
        const source = `package P
import System
func F(a string?) {
    if let x = a {
        Console.WriteLine(x)
    } else {
        Console.WriteLine("none")
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotNull(FindFirst[IfLetStatementSyntax](tree))
        Assert.Empty(Walk(tree.Root).OfType[IfLetExpressionSyntax]())
    }

    @Fact
    func StatementForm_IfLet_KeepsTopLevelLogicalAndInsideTheInitializer() {
        // The statement form has no guard clause, so `a && b` stays a single
        // initializer expression — the ADR-0151 delimiter rule is
        // expression-form only.
        const source = `package P
import System
func F(a bool, b bool) {
    if let ok = Wrap(a) && b {
        Console.WriteLine(ok)
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        let initializer = Assert.IsType[BinaryExpressionSyntax](stmt.Bindings[0].Initializer)
        Assert.Equal(SyntaxKind.AmpersandAmpersandToken, initializer.OperatorToken.Kind)
    }

    @Fact
    func StatementForm_GuardLet_StillParsesAsStatement() {
        const source = `package P
func F(a string?) int32 {
    guard let x = a else {
        return 0
    }
    return x.Length
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotNull(FindFirst[GuardLetStatementSyntax](tree))
    }

    @Fact
    func LambdaBlockBody_TrailingIfLet_IsTheExpressionForm() {
        // ADR-0200: every value-capable block, arrow-lambda bodies included,
        // reads its last item by one rule, so a trailing
        // `if let … else …` is the expression form here too (it used to stay
        // the ADR-0071 statement in a lambda body). A body ending in
        // `if let … { return … } else { return … }` keeps its meaning: the
        // exiting branches have the `never` type and the lambda's type comes
        // from its returns (Adr0200BlockTailTests.
        // LambdaTailWithExitingBranches_TakesItsTypeFromTheReturns runs it).
        const source = `package P
func F(a string?) int32 {
    let g = (s string?) -> {
        if let x = s {
            return x.Length
        } else {
            return 0
        }
    }
    return g(a)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotNull(FindFirst[IfLetExpressionSyntax](tree))
        Assert.Empty(Walk(tree.Root).OfType[IfLetStatementSyntax]())
    }

    shared {
        private func FindFirst[T SyntaxNode](tree SyntaxTree) T {
            return Walk(tree.Root).OfType[T]().First()
        }

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for c in node.GetChildren() {
                for d in Walk(c) {
                    yield d
                }
            }
        }
    }
}
