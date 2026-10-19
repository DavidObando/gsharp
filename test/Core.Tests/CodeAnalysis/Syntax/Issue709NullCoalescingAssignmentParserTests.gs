// <copyright file="Issue709NullCoalescingAssignmentParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #709 / ADR-0072: parser-level coverage for the `??=`
/// null-coalescing compound assignment in statement position.
open class Issue709NullCoalescingAssignmentParserTests {
    @Fact
    func Parses_LocalVariable_LHS() {
        const source = `package P
var x string? = nil
x ??= "v"`
        let stmt = GetSingleAssignmentInBlock(source)
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, stmt.OperatorToken.Kind)
        Assert.IsType[NameExpressionSyntax](stmt.Target)
        Assert.NotNull(stmt.Value)
    }

    @Fact
    func Parses_MemberField_LHS() {
        const source = `package P
import System
class Box {
    var Name string?
}
func main() {
    var b = Box{}
    b.Name ??= "v"
}
main()`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fnBody BlockStatementSyntax? = tree
            .Root
            .Members
            .OfType[FunctionDeclarationSyntax]()
            .Single((f FunctionDeclarationSyntax) -> f.Identifier.Text == "main")
            .Body
        let stmt = fnBody!!
            .Statements
            .OfType[ExpressionStatementSyntax]()
            .Select((e ExpressionStatementSyntax) -> e.Expression)
            .OfType[NullCoalescingAssignmentExpressionSyntax]()
            .Single()
        Assert.Equal(SyntaxKind.QuestionQuestionEqualsToken, stmt.OperatorToken.Kind)
        Assert.IsType[AccessorExpressionSyntax](stmt.Target)
    }

    @Fact
    func Parses_Indexer_LHS() {
        const source = `package P
import System
func main() {
    var m = map[string,string?]{}
    m["k"] ??= "v"
}
main()`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fnBody BlockStatementSyntax? = tree
            .Root
            .Members
            .OfType[FunctionDeclarationSyntax]()
            .Single((f FunctionDeclarationSyntax) -> f.Identifier.Text == "main")
            .Body
        let stmt = fnBody!!
            .Statements
            .OfType[ExpressionStatementSyntax]()
            .Select((e ExpressionStatementSyntax) -> e.Expression)
            .OfType[NullCoalescingAssignmentExpressionSyntax]()
            .Single()
        Assert.IsType[IndexExpressionSyntax](stmt.Target)
    }

    @Fact
    func Parses_RhsAsExpression() {
        // RHS may be any expression — ensure precedence works out so that
        // `a ??= b ?? c` parses as `a ??= (b ?? c)` (the `??` read binds
        // right-associatively and lower than `||`).
        const source = `package P
var x string? = nil
var y string? = nil
x ??= y ?? "fallback"`
        let stmt = GetSingleAssignmentInBlock(source)
        Assert.NotNull(stmt.Value)
        let value = Assert.IsType[BinaryExpressionSyntax](stmt.Value)
        Assert.Equal(SyntaxKind.QuestionQuestionToken, value.OperatorToken.Kind)
    }

    @Fact
    func Parses_BareQuestionQuestion_AsNullCoalescingExpression() {
        // Issue #941: bare `a ?? b` is now THE null-coalescing read operator
        // and parses cleanly (the former `?:` spelling was removed).
        const source = `package P
var x string? = nil
var y string = x ?? "v"`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    shared {
        private func GetSingleAssignmentInBlock(source string) NullCoalescingAssignmentExpressionSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            // The parser wraps a top-level `??=` statement in a GlobalStatement;
            // since issue #4967 the statement is an expression statement over
            // the `??=` expression.
            let stmt = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[ExpressionStatementSyntax]()
                .Select((e ExpressionStatementSyntax) -> e.Expression)
                .OfType[NullCoalescingAssignmentExpressionSyntax]()
                .Single()
            return stmt
        }
    }
}
