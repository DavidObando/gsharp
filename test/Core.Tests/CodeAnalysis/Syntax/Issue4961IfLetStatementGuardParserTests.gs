// <copyright file="Issue4961IfLetStatementGuardParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #4961 / ADR-0200 — parser coverage for the binding header shared by
/// every `let`-binding form: a top-level `&&` after the final binding starts
/// the guard in the `if let` statement exactly as in the expression, a `?:`
/// initializer is accepted by both forms, and the unsupported shapes report
/// diagnostics that name their syntax.
open class Issue4961IfLetStatementGuardParserTests {
    @Fact
    func Statement_IssueRepro_InitializerStopsAtTheGuard() {
        const source = `package Repro
func HasText(value string?) bool {
    if let text = value && text.Length > 0 {
        return true
    }
    return false
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        Assert.Equal("value", Assert.IsType[NameExpressionSyntax](stmt.Bindings[0].Initializer).IdentifierToken.Text)
        Assert.Equal(SyntaxKind.AmpersandAmpersandToken, stmt.GuardOperatorToken?.Kind)
        let guard_ = Assert.IsType[BinaryExpressionSyntax](stmt.Guard)
        Assert.Equal(SyntaxKind.GreaterToken, guard_.OperatorToken.Kind)
    }

    @Fact
    func Statement_MultipleBindings_GuardFollowsTheFinalBinding_AndMayUseLogicalOperators() {
        const source = `package P
func F(a string?, b string?) {
    if let x = a, let y = b && x.Length > 0 || y.Length > 0 {
        Use(x)
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        Assert.Equal(2, stmt.Bindings.Count)
        Assert.IsType[NameExpressionSyntax](stmt.Bindings[1].Initializer)
        Assert.Equal(SyntaxKind.PipePipeToken, Assert.IsType[BinaryExpressionSyntax](stmt.Guard).OperatorToken.Kind)
    }

    @Fact
    func Statement_NoGuard_LeavesTheGuardSlotsEmpty() {
        const source = `package P
func F(a string?) {
    if let x = a {
        Use(x)
    } else if let y = a && y.Length > 1 {
        Use(y)
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let statements = Walk(tree.Root).OfType[IfLetStatementSyntax]().ToList()
        Assert.Equal(2, statements.Count)
        Assert.Null(statements[0].GuardOperatorToken)
        Assert.Null(statements[0].Guard)
        Assert.NotNull(statements[1].Guard)
    }

    @Fact
    func Statement_ParenthesizedLogicalAnd_StaysInTheInitializer() {
        const source = `package P
func F(a bool, b bool, x string?, y string?) {
    if let v = (a && b ? x : y) && v.Length > 0 {
        Use(v)
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        Assert.IsType[ParenthesizedExpressionSyntax](stmt.Bindings[0].Initializer)
        Assert.NotNull(stmt.Guard)
    }

    @Fact
    func BothForms_ConditionalInitializer_FalseArmStopsAtTheGuard() {
        const source = `package P
func F(flag bool, x string?, y string?) string {
    if let v = flag ? x : y && v.Length > 0 {
        return v
    }
    return if let w = flag ? x : y && w.Length > 0 { w } else { "" }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        let statementInitializer = Assert.IsType[ConditionalExpressionSyntax](stmt.Bindings[0].Initializer)
        Assert.IsType[NameExpressionSyntax](statementInitializer.WhenFalse)
        Assert.NotNull(stmt.Guard)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        let expressionInitializer = Assert.IsType[ConditionalExpressionSyntax](expr.Bindings[0].Initializer)
        Assert.IsType[NameExpressionSyntax](expressionInitializer.WhenFalse)
        Assert.NotNull(expr.Guard)
    }

    @Fact
    func BothForms_CoalescingInitializer_StopsAtTheGuard() {
        const source = `package P
func F(a string?, b string?) string {
    if let v = a ?? b && v.Length > 0 {
        return v
    }
    return if let w = a ?? b && w.Length > 0 { w } else { "" }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        Assert.Equal(
            SyntaxKind.QuestionQuestionToken,
            Assert.IsType[BinaryExpressionSyntax](stmt.Bindings[0].Initializer).OperatorToken.Kind
        )
        Assert.NotNull(stmt.Guard)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        Assert.Equal(
            SyntaxKind.QuestionQuestionToken,
            Assert.IsType[BinaryExpressionSyntax](expr.Bindings[0].Initializer).OperatorToken.Kind
        )
        Assert.NotNull(expr.Guard)
    }

    @Fact
    func AssignmentInitializer_IsKept_AndItsRightHandSideStopsAtTheGuard() {
        // The guarded initializer is the full grammar, assignments included:
        // `cached = Next()` was a valid initializer before ADR-0200 and stays
        // one in every let-binding form.
        const source = `package P
var cached string? = nil
func Next() string? { return "n" }
func F() int32 {
    if let a = cached = Next() && a.Length > 0 {
        return 1
    }
    while let b = cached = Next() {
        break
    }
    guard let c = cached = Next() else {
        return 0
    }
    return if let d = cached = Next() && d.Length > 0 { 2 } else { 3 }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        let assignment = Assert.IsType[AssignmentExpressionSyntax](stmt.Bindings[0].Initializer)
        Assert.IsType[CallExpressionSyntax](assignment.Expression)
        Assert.NotNull(stmt.Guard)
        Assert.IsType[AssignmentExpressionSyntax](FindFirst[WhileLetStatementSyntax](tree).Bindings[0].Initializer)
        Assert.IsType[AssignmentExpressionSyntax](FindFirst[GuardLetStatementSyntax](tree).Bindings[0].Initializer)
        let expr = FindFirst[IfLetExpressionSyntax](tree)
        Assert.IsType[AssignmentExpressionSyntax](expr.Bindings[0].Initializer)
        Assert.NotNull(expr.Guard)
    }

    @Fact
    func TopLevelLogicalOr_AfterTheBindings_ReportsGS0626_InBothForms() {
        const source = `package P
func F(a string?, c bool) bool {
    if let v = a || c {
        return true
    }
    return if let w = a || c { true } else { false }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Equal([]string{"GS0626@3:18", "GS0626@6:25"}, Ids(tree))
        // The `||` and its right operand stay in the tree (guard slot), so the
        // source round-trips and recovery is local.
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        Assert.Equal(SyntaxKind.PipePipeToken, stmt.GuardOperatorToken?.Kind)
        Assert.Equal(WithoutWhitespace(source), TokenText(tree.Root))
    }

    @Fact
    func WhileLetAndGuardLet_Guard_ReportsGS0625_AndStaysOutOfTheInitializer() {
        const source = `package P
func F(a string?) int32 {
    while let v = a && v.Length > 0 {
        break
    }
    guard let w = a && w.Length > 0 else {
        return 0
    }
    return 1
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Equal([]string{"GS0625@3:21", "GS0625@6:21"}, Ids(tree))
        let whileLet = FindFirst[WhileLetStatementSyntax](tree)
        Assert.IsType[NameExpressionSyntax](whileLet.Bindings[0].Initializer)
        Assert.NotNull(whileLet.Guard)
        let guardLet = FindFirst[GuardLetStatementSyntax](tree)
        Assert.IsType[NameExpressionSyntax](guardLet.Bindings[0].Initializer)
        Assert.NotNull(guardLet.Guard)
    }

    @Fact
    func Statement_GuardTokens_AreEnumeratedBetweenBindingsAndThenBlock() {
        const source = `package P
func F(a string?) {
    if let v = a && v.Length > 0 {
    }
}`
        let tree = SyntaxTree.Parse(source)
        let stmt = FindFirst[IfLetStatementSyntax](tree)
        let kinds = stmt.GetChildren().Select((n SyntaxNode) -> n.Kind).ToList()
        Assert.Equal(
            []SyntaxKind{
                SyntaxKind.IfKeyword,
                SyntaxKind.IfLetBindingClause,
                SyntaxKind.AmpersandAmpersandToken,
                SyntaxKind.BinaryExpression,
                SyntaxKind.BlockStatement
            },
            kinds
        )
        Assert.Equal(WithoutWhitespace(source), TokenText(tree.Root))
    }

    shared {
        private func Ids(tree SyntaxTree)[]string {
            return tree
                .Diagnostics
                .Select((d Diagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
                .ToArray()
        }

        /// Concatenates every token's text in source order, so a dropped or
        /// reordered token shows up as a mismatch against the source.
        private func TokenText(node SyntaxNode) string {
            // A token can be reachable through more than one child accessor,
            // so keep one token per source position.
            return string.Concat(
                Walk(node)
                    .OfType[SyntaxToken]()
                    .Where((t SyntaxToken) -> t.Text.Length > 0)
                    .GroupBy((t SyntaxToken) -> t.Span.Start)
                    .OrderBy((g IGrouping[int32, SyntaxToken]) -> g.Key)
                    .Select((g IGrouping[int32, SyntaxToken]) -> g.First().Text)
            )
        }

        private func WithoutWhitespace(text string) string {
            return string.Concat(text.Where((c char) -> !char.IsWhiteSpace(c)))
        }

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
