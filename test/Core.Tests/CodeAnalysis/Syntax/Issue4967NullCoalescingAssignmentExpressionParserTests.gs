// <copyright file="Issue4967NullCoalescingAssignmentExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #4967 / ADR-0072 (amended): `??=` is parsed in the assignment
/// expression pipeline, so it is accepted in every value position the other
/// assignment operators are, and the statement form is an expression
/// statement over the same node.
open class Issue4967NullCoalescingAssignmentExpressionParserTests {
    @Fact
    func StatementForm_IsExpressionStatementOverTheExpressionNode() {
        let statement = Assert.IsType[ExpressionStatementSyntax](SingleGlobalStatement(`package P
var x string? = nil
x ??= "v"`))
        let coalesce = Assert.IsType[NullCoalescingAssignmentExpressionSyntax](statement.Expression)
        Assert.Equal(SyntaxKind.NullCoalescingAssignmentExpression, coalesce.Kind)
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, coalesce.OperatorToken.Kind)
        Assert.Equal("x", Assert.IsType[NameExpressionSyntax](coalesce.Target).IdentifierToken.Text)
    }

    @Theory
    @InlineData("let r = (t ??= \"v\")")
    @InlineData("let r = t ??= \"v\"")
    @InlineData("Console.WriteLine(t ??= \"v\")")
    @InlineData("u = t ??= \"v\"")
    @InlineData("let f = () -> t ??= \"v\"")
    func ValuePositions_ParseWithoutDiagnostics(line string) {
        let tree = SyntaxTree.Parse(`package P
import System
var t string? = nil
var u string? = nil
` + line)
        Assert.Empty(tree.Diagnostics)
        Assert.Single(tree.Root.DescendantNodes().OfType[NullCoalescingAssignmentExpressionSyntax]())
    }

    @Fact
    func ReturnValue_Parses() {
        let tree = SyntaxTree.Parse(`package P
func F(x string?) string {
    var y = x
    return y ??= "v"
}`)
        Assert.Empty(tree.Diagnostics)
        let ret = tree.Root.DescendantNodes().OfType[ReturnStatementSyntax]().Single()
        Assert.IsType[NullCoalescingAssignmentExpressionSyntax](ret.Expression)
    }

    @Fact
    func Chain_IsRightAssociative() {
        let statement = Assert.IsType[ExpressionStatementSyntax](SingleGlobalStatement(`package P
var a string? = nil
var b string? = nil
a ??= b ??= "c"`))
        let outer = Assert.IsType[NullCoalescingAssignmentExpressionSyntax](statement.Expression)
        Assert.Equal("a", Assert.IsType[NameExpressionSyntax](outer.Target).IdentifierToken.Text)
        let inner = Assert.IsType[NullCoalescingAssignmentExpressionSyntax](outer.Value)
        Assert.Equal("b", Assert.IsType[NameExpressionSyntax](inner.Target).IdentifierToken.Text)
        Assert.IsType[LiteralExpressionSyntax](inner.Value)
    }

    @Fact
    func AssignmentValue_IsTheCoalescingAssignment() {
        let statement = Assert.IsType[ExpressionStatementSyntax](SingleGlobalStatement(`package P
var a string? = nil
var b string? = nil
a = b ??= "c"`))
        let assignment = Assert.IsType[AssignmentExpressionSyntax](statement.Expression)
        Assert.IsType[NullCoalescingAssignmentExpressionSyntax](assignment.Expression)
    }

    @Fact
    func IndexAndMemberTargets_AreWholePostfixChains() {
        let tree = SyntaxTree.Parse(`package P
import System
func F(a []string?, o Box) {
    let r = (a[i()] ??= v())
    let s = (o.Next().F ??= v())
}`)
        Assert.Empty(tree.Diagnostics)
        let nodes = tree.Root.DescendantNodes().OfType[NullCoalescingAssignmentExpressionSyntax]().ToArray()
        Assert.Equal(2, nodes.Length)
        Assert.IsType[IndexExpressionSyntax](nodes[0].Target)
        Assert.IsType[AccessorExpressionSyntax](nodes[1].Target)
    }

    shared {
        private func SingleGlobalStatement(source string) StatementSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            return tree.Root.Members.OfType[GlobalStatementSyntax]().Last().Statement
        }
    }
}
