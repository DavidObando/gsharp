// <copyright file="Issue4961IfLetStatementPrinterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #4961 / ADR-0200: gsc now ends every `let`-binding initializer at a
/// top-level `&&` or `||` (the `&&` starts the statement form's guard too).
/// cs2gs never emits a statement-form guard (its output must still compile
/// with the pinned previous release), so it must keep parenthesizing an
/// initializer whose own top-level operator is a logical or coalescing one.
/// Each case prints the statement, re-parses it with gsc's parser, and checks
/// that the whole operator stayed inside the initializer.
open class Issue4961IfLetStatementPrinterTests {
    @Fact
    func LogicalAndInitializer_IsParenthesized_AndReparsesAsOneInitializer() {
        let printed = PrintIfLet(BinaryExpression(IdentifierExpression("a"), "&&", IdentifierExpression("b")))
        Assert.Contains("if let v = (a && b) {", printed, StringComparison.Ordinal)
        AssertSingleParenthesizedInitializer(printed, SyntaxKind.AmpersandAmpersandToken)
    }

    @Fact
    func LogicalOrInitializer_IsParenthesized_AndReparsesAsOneInitializer() {
        let printed = PrintIfLet(BinaryExpression(IdentifierExpression("a"), "||", IdentifierExpression("b")))
        Assert.Contains("if let v = (a || b) {", printed, StringComparison.Ordinal)
        AssertSingleParenthesizedInitializer(printed, SyntaxKind.PipePipeToken)
    }

    @Fact
    func CoalescingInitializer_IsParenthesized_AndReparsesAsOneInitializer() {
        let printed = PrintIfLet(BinaryExpression(IdentifierExpression("a"), "??", IdentifierExpression("b")))
        Assert.Contains("if let v = (a ?? b) {", printed, StringComparison.Ordinal)
        AssertSingleParenthesizedInitializer(printed, SyntaxKind.QuestionQuestionToken)
    }

    shared {
        private func PrintIfLet(initializer GExpression) string {
            let statement = IfLetStatement(
                []IfLetBinding{IfLetBinding("v", initializer)},
                BlockStatement([]GStatement{ExpressionStatement(IdentifierExpression("v"))})
            )
            let unit = CompilationUnit(
                "Demo",
                members: List[GNode]{MethodDeclaration("Run", body: BlockStatement(List[GStatement]{statement}))}
            )
            return GSharpPrinter.Print(unit)
        }

        private func AssertSingleParenthesizedInitializer(printed string, operatorKind SyntaxKind) {
            let tree = SyntaxTree.Parse(printed)
            Assert.Empty(tree.Diagnostics)
            let statement = Walk(tree.Root).OfType[IfLetStatementSyntax]().Single()
            Assert.Null(statement.Guard)
            let parenthesized = Assert.IsType[ParenthesizedExpressionSyntax](statement.Bindings[0].Initializer)
            Assert.Equal(
                operatorKind,
                Assert.IsType[BinaryExpressionSyntax](parenthesized.Expression).OperatorToken.Kind
            )
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
