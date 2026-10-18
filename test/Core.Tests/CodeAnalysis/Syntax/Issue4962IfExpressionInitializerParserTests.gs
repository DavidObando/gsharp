// <copyright file="Issue4962IfExpressionInitializerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #4962 / ADR-0064: the if-expression accepts the same
/// `if init; cond` header as the if-statement, because both forms parse
/// the header with one routine. Each test pairs the two forms or pins the
/// expression form's tree shape.
open class Issue4962IfExpressionInitializerParserTests {
    @Fact
    func Parses_IssueRepro_ExpressionForm() {
        const source = `import System
func g() int32 { return 5 }
let s = if var v = g(); v > 3 { "expr-init ${v}" } else { "no" }
Console.WriteLine(s)`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let expr = FindFirst[IfExpressionSyntax](tree)
        let initializer = Assert.IsType[VariableDeclarationSyntax](expr.Initializer)
        Assert.Equal("v", initializer.Identifier.Text)
        Assert.NotNull(expr.Semicolon)
        Assert.Equal(SyntaxKind.SemicolonToken, expr.Semicolon!!.Kind)
        let condition = Assert.IsType[BinaryExpressionSyntax](expr.Condition)
        Assert.Equal(SyntaxKind.GreaterToken, condition.OperatorToken.Kind)
        Assert.IsType[BlockExpressionSyntax](expr.ElseExpression)
    }

    @Theory
    @InlineData("var v = x")
    @InlineData("x = 1")
    @InlineData("x++")
    @InlineData("H()")
    func StatementAndExpressionForms_ParseTheSameInitializer(initializer string) {
        let statementSource = "func H() { }\nfunc F() {\n    var x = 0\n    if ${initializer}; x >= 0 { x = 1 } else { x = 2 }\n}"
        let expressionSource = "func H() { }\nfunc F() int32 {\n    var x = 0\n    return if ${initializer}; x >= 0 { 1 } else { 2 }\n}"
        let statementTree = SyntaxTree.Parse(statementSource)
        let expressionTree = SyntaxTree.Parse(expressionSource)
        Assert.Empty(statementTree.Diagnostics)
        Assert.Empty(expressionTree.Diagnostics)
        let statement = FindFirst[IfStatementSyntax](statementTree)
        let expression = FindFirst[IfExpressionSyntax](expressionTree)
        Assert.NotNull(statement.Initializer)
        Assert.NotNull(expression.Initializer)
        Assert.Equal(statement.Initializer!!.Kind, expression.Initializer!!.Kind)
        Assert.Equal(
            statementTree.Text.ToString(statement.Initializer!!.Span),
            expressionTree.Text.ToString(expression.Initializer!!.Span)
        )
        Assert.Equal(
            statementTree.Text.ToString(statement.Condition.Span),
            expressionTree.Text.ToString(expression.Condition.Span)
        )
    }

    @Fact
    func Children_AreInSourceOrder_AndSpanCoversInitializer() {
        const ifText = "if var v = g(); v > 3 { 1 } else { 2 }"
        let source = "func g() int32 { return 5 }\nlet s = ${ifText}"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let expr = FindFirst[IfExpressionSyntax](tree)
        Assert.Equal(ifText, tree.Text.ToString(expr.Span))
        let kinds = expr.GetChildren().Select((c SyntaxNode) -> c.Kind).ToArray()
        Assert.Equal(
            []SyntaxKind{
                SyntaxKind.IfKeyword,
                SyntaxKind.VariableDeclaration,
                SyntaxKind.SemicolonToken,
                SyntaxKind.BinaryExpression,
                SyntaxKind.BlockExpression,
                SyntaxKind.ElseKeyword,
                SyntaxKind.BlockExpression
            },
            kinds
        )
    }

    @Fact
    func ElseIfChain_EachLinkHasItsOwnInitializer() {
        const source = `func g() int32 { return 5 }
let s = if var a = g(); a > 9 { 1 } else if var b = a * 2; b > 3 { 2 } else { 3 }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = FindFirst[IfExpressionSyntax](tree)
        Assert.Equal("a", Assert.IsType[VariableDeclarationSyntax](outer.Initializer).Identifier.Text)
        let inner = Assert.IsType[IfExpressionSyntax](outer.ElseExpression)
        Assert.Equal("b", Assert.IsType[VariableDeclarationSyntax](inner.Initializer).Identifier.Text)
        Assert.NotNull(inner.Semicolon)
    }

    @Fact
    func TrailingIfInLambdaBody_WithInitializer_ParsesAsIfExpression() {
        // A trailing else-terminated `if` in an arrow-lambda block body is the
        // expression form (issue #2349), so this shape failed to parse before
        // issue #4962 even though the same `if` parses as a statement in a
        // func body.
        const source = `import System
func g() int32 { return 5 }
let act = () -> { if var v = g(); v > 3 { Console.WriteLine(v) } else { Console.WriteLine(0) } }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let expr = FindFirst[IfExpressionSyntax](tree)
        Assert.IsType[VariableDeclarationSyntax](expr.Initializer)
    }

    @Fact
    func IfWithoutInitializer_HasNoInitializerInEitherForm() {
        let statementTree = SyntaxTree.Parse("func F(x int32) {\n    if x > 0 { }\n}")
        let expressionTree = SyntaxTree.Parse("func F(x int32) int32 -> if x > 0 { 1 } else { 2 }")
        Assert.Empty(statementTree.Diagnostics)
        Assert.Empty(expressionTree.Diagnostics)
        Assert.Null(FindFirst[IfStatementSyntax](statementTree).Initializer)
        let expression = FindFirst[IfExpressionSyntax](expressionTree)
        Assert.Null(expression.Initializer)
        Assert.Null(expression.Semicolon)
    }

    @Theory
    @InlineData("if let v = g(); v > 3 { 1 } else { 2 }")
    @InlineData("if var v = g(); let w = v { 1 } else { 2 }")
    func LetBindingHeaderAndInitializer_AreExclusive_InBothForms(ifText string) {
        // `if let` dispatches to the binding form before an initializer is
        // considered, and a `let` binding cannot follow an initializer. Both
        // forms reject these headers.
        let statementTree = SyntaxTree.Parse("func g() int32 { return 5 }\nfunc F() {\n    ${ifText}\n}")
        let expressionTree = SyntaxTree.Parse("func g() int32 { return 5 }\nlet s = ${ifText}")
        Assert.Contains(statementTree.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0005")
        Assert.Contains(expressionTree.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0005")
    }

    @Theory
    @InlineData("if if var x = 1; x > 0 { true } else { false }")
    @InlineData("if flags[if var i = 1; i > 0 { i } else { 0 }]")
    @InlineData("if flags?[if var i = 1; i > 0 { i } else { 0 }] == true")
    func NestedIfExpressionInCondition_KeepsItsSemicolon_InBothForms(head string) {
        // The `;` of an if-expression nested in the condition, directly or
        // inside brackets, belongs to the nested `if`. It is not the outer
        // header's initializer separator.
        let statementTree = SyntaxTree.Parse("func F(flags []bool) {\n    ${head} { flags[0] = true }\n}")
        let expressionTree = SyntaxTree.Parse("func F(flags []bool) int32 -> ${head} { 1 } else { 2 }")
        Assert.Empty(statementTree.Diagnostics)
        Assert.Empty(expressionTree.Diagnostics)
        Assert.Null(FindFirst[IfStatementSyntax](statementTree).Initializer)
        let outer = FindFirst[IfExpressionSyntax](expressionTree)
        Assert.Null(outer.Initializer)
        let nested = Walk(outer.Condition).OfType[IfExpressionSyntax]().Single()
        Assert.IsType[VariableDeclarationSyntax](nested.Initializer)
        let nestedInStatement = Walk(FindFirst[IfStatementSyntax](statementTree).Condition).OfType[IfExpressionSyntax]()
            .Single()
        Assert.IsType[VariableDeclarationSyntax](nestedInStatement.Initializer)
    }

    @Fact
    func OuterInitializer_FollowedByNestedIfExpressionCondition() {
        const source = "func F() int32 -> if var a = 1; if var b = a; b > 0 { true } else { false } { a } else { 0 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = FindFirst[IfExpressionSyntax](tree)
        Assert.Equal("a", Assert.IsType[VariableDeclarationSyntax](outer.Initializer).Identifier.Text)
        let nested = Assert.IsType[IfExpressionSyntax](outer.Condition)
        Assert.Equal("b", Assert.IsType[VariableDeclarationSyntax](nested.Initializer).Identifier.Text)
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
