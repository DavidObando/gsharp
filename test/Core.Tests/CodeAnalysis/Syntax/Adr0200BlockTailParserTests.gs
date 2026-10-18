// <copyright file="Adr0200BlockTailParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0202 / issues #4963, #4965, #4966: the parser decides what the last item
/// of a value-capable block means by one rule, decides `switch` by its arm
/// shape, accepts comma arms in both switch forms, and parses `-> { … }` member
/// bodies as block bodies.
open class Adr0200BlockTailParserTests {
    @Fact
    func Switch_IsDecidedByItsArmShape() {
        let tree = Parse(`func f(x int32) {
    switch x {
    case 1: A()
    default: B()
    }
    switch x {
    case 1 { A() }
    default { B() }
    }
    switch x {
    case int32 { Value: > 0 } when x > 1: A()
    default: B()
    }
    switch x {
    case int32 { Value: > 0 } { A() }
    default { B() }
    }
    switch x { }
    switch g {
    case h is (int32) -> string { A() }
    default { B() }
    }
}`)
        let body = Body(tree, "f")
        Assert.Equal(6, body.Statements.Length)
        // A `->` in a function-type pattern does not make the arm an
        // expression arm.
        Assert.IsType[SwitchStatementSyntax](body.Statements[5])
        Assert.IsType[SwitchExpressionSyntax](Assert.IsType[ExpressionStatementSyntax](body.Statements[0]).Expression)
        Assert.IsType[SwitchStatementSyntax](body.Statements[1])
        Assert.IsType[SwitchExpressionSyntax](Assert.IsType[ExpressionStatementSyntax](body.Statements[2]).Expression)
        Assert.IsType[SwitchStatementSyntax](body.Statements[3])
        Assert.IsType[SwitchStatementSyntax](body.Statements[4])
    }

    // A `?` in the first arm is a nullable type or a conditional; neither its
    // `?` nor a conditional's `:` decides the form.
    @Fact
    func QuestionTokensInTheFirstArm_DoNotDecideTheForm() {
        let tree = Parse(`func f(x int32, o object) {
    switch x {
    case 1 when o as int32? != nil: A()
    default: B()
    }
    switch 1 {
    case true ? 1 : 2 { A() }
    default { B() }
    }
}`)
        let body = Body(tree, "f")
        Assert.IsType[SwitchExpressionSyntax](Assert.IsType[ExpressionStatementSyntax](body.Statements[0]).Expression)
        Assert.IsType[SwitchStatementSyntax](body.Statements[1])
    }

    // The deprecated `->` arm separator still selects the expression form.
    @Fact
    func DeprecatedArrowSeparator_SelectsTheExpressionForm() {
        let tree = SyntaxTree.Parse(`func f(x int32) {
    switch x {
    case 1 -> A()
    default -> B()
    }
}`)
        Assert.All(tree.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> Assert.Equal("GS0302", d.Id))
        Assert.NotEmpty(tree.Diagnostics)
        Assert.IsType[SwitchExpressionSyntax](
            Assert.IsType[ExpressionStatementSyntax](Assert.Single(Body(tree, "f").Statements)).Expression
        )
    }

    // The switch form is decided by a token scan after the header is parsed
    // once, so nested switch headers parse in linear time (a speculative
    // header parse doubled the work at every level).
    @Fact
    func NestedSwitchHeaders_ParseInLinearTime() {
        var inner = "switch 0 { default { } }"
        for var i = 0; i < 40; i++ {
            inner = "switch { " + inner + " 0 } { default { } }"
        }
        let source = "func f() {\n" + inner + "\n}"
        let stopwatch = System.Diagnostics.Stopwatch.StartNew()
        let tree = Parse(source)
        stopwatch.Stop()
        Assert.True(stopwatch.ElapsedMilliseconds < 5000, "parse took ${stopwatch.ElapsedMilliseconds} ms")
        Assert.Equal(41, Walk(tree.Root).OfType[SwitchStatementSyntax]().Count())
    }

    // The single-arm fallback skips brace bodies, so a switch nested in a
    // first-arm guard is not parsed twice per level either.
    @Fact
    func NestedSwitchesInFirstArmGuards_ParseInLinearTime() {
        var inner = "switch 0 { default { } }"
        for var i = 0; i < 40; i++ {
            inner = "switch 0 { case _ when true ? { " + inner + " true } : false { } }"
        }
        let source = "func f() {\n" + inner + "\n}"
        let stopwatch = System.Diagnostics.Stopwatch.StartNew()
        let tree = Parse(source)
        stopwatch.Stop()
        Assert.True(stopwatch.ElapsedMilliseconds < 5000, "parse took ${stopwatch.ElapsedMilliseconds} ms")
        Assert.Equal(41, Walk(tree.Root).OfType[SwitchStatementSyntax]().Count())
    }

    @Fact
    func NestedIfLetInitializers_ParseInLinearTime() {
        var initializer = "input"
        for var i = 0; i < 40; i++ {
            initializer = "if let value = " + initializer + " { value } else { nil }"
        }
        let source = "func f(input string?) { let g = () -> { if let result = " + initializer + " { 1 } else { 0 } } }"
        let stopwatch = System.Diagnostics.Stopwatch.StartNew()
        let tree = Parse(source)
        stopwatch.Stop()
        Assert.True(stopwatch.ElapsedMilliseconds < 5000, "parse took ${stopwatch.ElapsedMilliseconds} ms")
        Assert.Equal(41, Walk(tree.Root).OfType[IfLetExpressionSyntax]().Count())
    }

    // A long `-> { … }.ToString()` is still one continued expression: the
    // continuation is decided at the real closing brace, not within a capped
    // lookahead.
    @Fact
    func LongContinuedArrowBraceBody_StaysOneExpression() {
        let body = System.Text.StringBuilder()
        for var i = 0; i < 2000; i++ {
            body.Append("Log()\n")
        }
        let tree = Parse("func f() string -> {\n" + body.ToString() + "1 }.ToString()\nfunc Log() { }")
        let returned = Assert.IsType[ReturnStatementSyntax](Assert.Single(Body(tree, "f").Statements))
        Assert.IsNotType[BlockExpressionSyntax](returned.Expression)
    }

    @Fact
    func CommaArms_FoldIntoDisjunctionsInBothForms() {
        let tree = Parse(`func f(x int32) string {
    switch x {
    case 1, 2, 3 { }
    default { }
    }
    return switch x {
    case 1, 2: "a"
    default: "b"
    }
}`)
        let switchStatement = Walk(tree.Root).OfType[SwitchStatementSyntax]().Single()
        let statementPattern = Assert.IsType[BinaryPatternSyntax](switchStatement.Cases[0].Value)
        Assert.IsType[BinaryPatternSyntax](statementPattern.Left)
        let switchExpression = Walk(tree.Root).OfType[SwitchExpressionSyntax]().Single()
        let expressionPattern = Assert.IsType[BinaryPatternSyntax](switchExpression.Arms[0].Value)
        Assert.Equal(SyntaxKind.CommaToken, expressionPattern.OperatorToken.Kind)
    }

    @Fact
    func LastItem_IsReadByTheSameRuleInEveryValueCapableBlock() {
        let tree = Parse(`func f(o string?) {
    let a = () -> {
        let x = 1
        { x + 1 }
    }
    let b = () -> {
        if let s = o { s.Length } else { 0 }
    }
    let c = () -> {
        switch 1 {
        case 1: "one"
        default: "other"
        }
    }
    let d = {
        let x = 1
        { x + 1 }
    }
}`)
        let lambdas = Walk(tree.Root).OfType[LambdaExpressionSyntax]().ToList()
        Assert.Equal(3, lambdas.Count)
        Assert.IsType[BlockExpressionSyntax](Assert.IsType[BlockExpressionSyntax](lambdas[0].Body).Expression)
        Assert.IsType[IfLetExpressionSyntax](Assert.IsType[BlockExpressionSyntax](lambdas[1].Body).Expression)
        Assert.IsType[SwitchExpressionSyntax](Assert.IsType[BlockExpressionSyntax](lambdas[2].Body).Expression)
        let declarations = Walk(tree.Root).OfType[VariableDeclarationSyntax]().ToList()
        let d = Assert.IsType[BlockExpressionSyntax](
            declarations.Single((v VariableDeclarationSyntax) -> v.Identifier.Text == "d").Initializer
        )
        Assert.IsType[BlockExpressionSyntax](d.Expression)
    }

    @Fact
    func ArrowMemberBlockBody_IsTheEquivalentBlockBody() {
        let tree = Parse(`func value(x int32) int32 -> {
    if x > 0 { return 1 }
    let y = x
    y + 2
}
func noTail(x int32) int32 -> {
    if x > 0 { return 1 }
    return 2
}
func noValue(x int32) -> {
    for var i = 0; i < x; i++ { }
}
func continued() string -> { 1 }.ToString()`)
        let value = Body(tree, "value")
        Assert.Equal("{", value.OpenBraceToken.Text)
        Assert.Equal(3, value.Statements.Length)
        Assert.IsType[IfStatementSyntax](value.Statements[0])
        let tail = Assert.IsType[ReturnStatementSyntax](value.Statements[2])
        Assert.IsType[BinaryExpressionSyntax](tail.Expression)
        let noTail = Body(tree, "noTail")
        Assert.Equal(2, noTail.Statements.Length)
        Assert.IsType[ReturnStatementSyntax](noTail.Statements[1])
        let voidBody = Body(tree, "noValue")
        Assert.IsType[ForClauseStatementSyntax](Assert.Single(voidBody.Statements))
        // A continued brace is still one expression, returned as before.
        let continued = Assert.IsType[ReturnStatementSyntax](Assert.Single(Body(tree, "continued").Statements))
        Assert.IsNotType[BlockExpressionSyntax](continued.Expression)
    }

    shared {
        private func Parse(source string) SyntaxTree {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            return tree
        }

        private func Body(tree SyntaxTree, name string) BlockStatementSyntax -> Invariant(
            Walk(tree.Root)
                .OfType[FunctionDeclarationSyntax]()
                .Single((f FunctionDeclarationSyntax) -> f.Identifier.Text == name)
                .Body
        )

        private func Invariant(body BlockStatementSyntax?) BlockStatementSyntax {
            Assert.NotNull(body)
            return body ?? throw System.InvalidOperationException("no body")
        }

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Walk(child) {
                    yield descendant
                }
            }
        }
    }
}
