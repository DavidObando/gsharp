// <copyright file="Issue3356NullConditionalInvocationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Issue #3356 parser coverage for null-conditional postfix invocation.</summary>
public class Issue3356NullConditionalInvocationParserTests
{
    [Theory]
    [InlineData("GetHandler()?(x)", typeof(CallExpressionSyntax))]
    [InlineData("handlers[0]?(x)", typeof(IndexExpressionSyntax))]
    [InlineData("(handler)?(x)", typeof(ParenthesizedExpressionSyntax))]
    [InlineData("(left ?? right)?(x)", typeof(ParenthesizedExpressionSyntax))]
    [InlineData("holder.Handler?(x)", typeof(AccessorExpressionSyntax))]
    [InlineData("GetHolder().Handler?(x)", typeof(AccessorExpressionSyntax))]
    public void Parses_PostfixReceiver_NullConditionalInvocation(string text, System.Type calleeType)
    {
        var expression = ParseExpression(text);

        var call = expression is AccessorExpressionSyntax accessor
            ? Assert.IsType<CallExpressionSyntax>(accessor.RightPart)
            : Assert.IsType<CallExpressionSyntax>(expression);
        Assert.NotNull(call.NullableQuestionToken);
        Assert.Equal(SyntaxKind.QuestionToken, call.NullableQuestionToken!.Kind);
        if (expression is AccessorExpressionSyntax)
        {
            Assert.Null(call.Callee);
            Assert.Equal("Handler", call.Identifier.Text);
            Assert.Equal(calleeType, expression.GetType());
        }
        else
        {
            Assert.IsType(calleeType, call.Callee);
        }
    }

    [Fact]
    public void TernaryWithParenthesizedTrueArm_RemainsConditional()
    {
        var expression = ParseExpression("condition ? (handler) : fallback");

        var conditional = Assert.IsType<ConditionalExpressionSyntax>(expression);
        Assert.IsType<NameExpressionSyntax>(conditional.Condition);
        Assert.IsType<ParenthesizedExpressionSyntax>(conditional.WhenTrue);
        Assert.IsType<NameExpressionSyntax>(conditional.WhenFalse);
    }

    [Fact]
    public void TriviaAroundQuestionOrParenthesis_RemainsConditional()
    {
        foreach (var expression in new[]
        {
            "GetHandler() ? (x) : fallback",
            "GetHandler()? (x) : fallback",
            "condition? (x) : fallback",
        })
        {
            var parsed = ParseExpression(expression);
            Assert.IsType<ConditionalExpressionSyntax>(parsed);
        }
    }

    [Fact]
    public void MissingCloseParenthesis_RecoversAsInvocationNotTernary()
    {
        var tree = SyntaxTree.Parse("package P\nlet result = GetHandler()?(x\n");

        Assert.NotEmpty(tree.Diagnostics);
        Assert.DoesNotContain(
            tree.Diagnostics,
            diagnostic => diagnostic.Message.Contains("ColonToken", System.StringComparison.Ordinal));
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        Assert.IsType<CallExpressionSyntax>(declaration.Initializer);
    }

    private static ExpressionSyntax ParseExpression(string text)
    {
        var tree = SyntaxTree.Parse("package P\nlet result = " + text + "\n");
        Assert.Empty(tree.Diagnostics);
        return tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single()
            .Initializer;
    }
}
