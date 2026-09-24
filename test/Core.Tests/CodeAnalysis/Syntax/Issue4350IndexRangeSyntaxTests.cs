// <copyright file="Issue4350IndexRangeSyntaxTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0187 / issue #4350: prefix <c>^x</c> parses as a first-class
/// <see cref="FromEndIndexExpressionSyntax"/> in every expression context at
/// unary precedence, <c>~x</c> is the one's-complement unary operator, and
/// binary <c>^</c> stays XOR.
/// </summary>
public class Issue4350IndexRangeSyntaxTests
{
    [Fact]
    public void Lexer_ProducesTildeToken()
    {
        var tokens = SyntaxTree.ParseTokens("~x");
        Assert.Equal(SyntaxKind.TildeToken, tokens[0].Kind);
        Assert.Equal("~", SyntaxFacts.GetText(SyntaxKind.TildeToken));
    }

    [Fact]
    public void PrefixHat_IsFromEndIndex_InLocalInitializer()
    {
        var fromEnd = Assert.IsType<FromEndIndexExpressionSyntax>(GetInitializer("let last = ^1"));
        Assert.Equal(SyntaxKind.HatToken, fromEnd.HatToken.Kind);
        Assert.IsType<LiteralExpressionSyntax>(fromEnd.Operand);
    }

    [Fact]
    public void PrefixHat_IsFromEndIndex_InArgumentPosition()
    {
        var call = Assert.IsType<CallExpressionSyntax>(GetInitializer("let x = consume(^2, ^n)"));
        Assert.All(call.Arguments, argument => Assert.IsType<FromEndIndexExpressionSyntax>(argument));
    }

    [Fact]
    public void PrefixHat_BindsAtUnaryPrecedence()
    {
        // `^a + 1` is `(^a) + 1`, exactly as in C#.
        var binary = Assert.IsType<BinaryExpressionSyntax>(GetInitializer("let x = ^a + 1"));
        Assert.IsType<FromEndIndexExpressionSyntax>(binary.Left);
        Assert.Equal(SyntaxKind.PlusToken, binary.OperatorToken.Kind);

        // Postfix member access binds tighter: `^a.b` is `^(a.b)`.
        var member = Assert.IsType<FromEndIndexExpressionSyntax>(GetInitializer("let y = ^a.b"));
        Assert.IsNotType<NameExpressionSyntax>(member.Operand);
    }

    [Fact]
    public void ParenthesizedPrefixHat_IsStillFromEndIndex()
    {
        var parenthesized = Assert.IsType<ParenthesizedExpressionSyntax>(GetInitializer("let x = (^n)"));
        Assert.IsType<FromEndIndexExpressionSyntax>(parenthesized.Expression);
    }

    [Fact]
    public void StandaloneRange_AcceptsLeadingFromEndBound()
    {
        var range = Assert.IsType<RangeExpressionSyntax>(GetInitializer("let r = ^4..^1"));
        Assert.IsType<FromEndIndexExpressionSyntax>(range.LowerBound);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.UpperBound);

        var tail = Assert.IsType<RangeExpressionSyntax>(GetInitializer("let r = ^3.."));
        Assert.IsType<FromEndIndexExpressionSyntax>(tail.LowerBound);
        Assert.Null(tail.UpperBound);
    }

    [Fact]
    public void Tilde_IsUnaryOnesComplement()
    {
        var unary = Assert.IsType<UnaryExpressionSyntax>(GetInitializer("let x = ~mask"));
        Assert.Equal(SyntaxKind.TildeToken, unary.OperatorToken.Kind);
    }

    [Fact]
    public void TildeInsideIndexBracket_StaysOnesComplement()
    {
        var index = Assert.IsType<IndexExpressionSyntax>(GetInitializer("let x = a[~i]"));
        var unary = Assert.IsType<UnaryExpressionSyntax>(index.Index);
        Assert.Equal(SyntaxKind.TildeToken, unary.OperatorToken.Kind);
    }

    [Fact]
    public void BinaryHat_StaysXor()
    {
        var binary = Assert.IsType<BinaryExpressionSyntax>(GetInitializer("let x = a ^ b"));
        Assert.Equal(SyntaxKind.HatToken, binary.OperatorToken.Kind);
    }

    [Fact]
    public void TildeOperatorDeclaration_MapsToOnesComplementName()
    {
        var tree = SyntaxTree.Parse("""
            package P
            struct Bits(Value int32) {
            }
            func (a Bits) operator ~() Bits -> Bits{Value: ~a.Value}
            """);
        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Equal("op_OnesComplement", function.Identifier.Text);
    }

    private static ExpressionSyntax GetInitializer(string statement)
    {
        var tree = SyntaxTree.Parse("package P\n" + statement);
        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        return declaration.Initializer;
    }
}
