// <copyright file="Issue3356NullConditionalInvocationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Linq
import Xunit

/// Issue #3356 parser coverage for null-conditional postfix invocation.
open class Issue3356NullConditionalInvocationParserTests {
    @Theory
    @InlineData("GetHandler()?(x)", typeof(CallExpressionSyntax))
    @InlineData("handlers[0]?(x)", typeof(IndexExpressionSyntax))
    @InlineData("(handler)?(x)", typeof(ParenthesizedExpressionSyntax))
    @InlineData("(left ?? right)?(x)", typeof(ParenthesizedExpressionSyntax))
    @InlineData("holder.Handler?(x)", typeof(AccessorExpressionSyntax))
    @InlineData("GetHolder().Handler?(x)", typeof(AccessorExpressionSyntax))
    func Parses_PostfixReceiver_NullConditionalInvocation(text string, calleeType Type) {
        let expression ExpressionSyntax? = ParseExpression(text)
        let call = if expression is AccessorExpressionSyntax accessor {
            Assert.IsType[CallExpressionSyntax](accessor.RightPart)
        } else {
            Assert.IsType[CallExpressionSyntax](expression)
        }
        Assert.NotNull(call.NullableQuestionToken)
        Assert.Equal(SyntaxKind.QuestionToken, call.NullableQuestionToken!!.Kind)
        if expression is AccessorExpressionSyntax {
            Assert.Null(call.Callee)
            Assert.Equal("Handler", call.Identifier.Text)
            Assert.Equal(calleeType, expression.GetType())
        } else {
            Assert.IsType(calleeType, call.Callee)
        }
    }

    @Fact
    func TernaryWithParenthesizedTrueArm_RemainsConditional() {
        let expression ExpressionSyntax? = ParseExpression("condition ? (handler) : fallback")
        let conditional = Assert.IsType[ConditionalExpressionSyntax](expression)
        Assert.IsType[NameExpressionSyntax](conditional.Condition)
        Assert.IsType[ParenthesizedExpressionSyntax](conditional.WhenTrue)
        Assert.IsType[NameExpressionSyntax](conditional.WhenFalse)
    }

    @Fact
    func TriviaAroundQuestionOrParenthesis_RemainsConditional() {
        for expression in[]string{
            "GetHandler() ? (x) : fallback",
            "GetHandler()? (x) : fallback",
            "condition? (x) : fallback"
        } {
            let parsed ExpressionSyntax? = ParseExpression(expression)
            Assert.IsType[ConditionalExpressionSyntax](parsed)
        }
    }

    @Fact
    func MissingCloseParenthesis_RecoversAsInvocationNotTernary() {
        let tree = SyntaxTree.Parse(`package P
let result = GetHandler()?(x
`)
        Assert.NotEmpty(tree.Diagnostics)
        Assert.DoesNotContain(
            tree.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Message.Contains("ColonToken", StringComparison.Ordinal)
        )
        let declaration = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        Assert.IsType[CallExpressionSyntax](declaration.Initializer)
    }

    shared {
        private func ParseExpression(text string) ExpressionSyntax? {
            let tree = SyntaxTree.Parse("package P\nlet result = " + text + "\n")
            Assert.Empty(tree.Diagnostics)
            return tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((member GlobalStatementSyntax) -> member.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
                .Initializer
        }
    }
}
