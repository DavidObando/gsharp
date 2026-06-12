// <copyright file="ParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public class ParserTests
{
    [Fact]
    public void Parses_HelloWorld_Sample_Without_Diagnostics()
    {
        const string source = @"
package HelloWorld

import System

Console.WriteLine(""Hello, world!"")
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.NotNull(tree.Root);
        var pkg = tree.Root.Members.OfType<PackageSyntax>().Single();
        Assert.Equal("HelloWorld", pkg.Identifiers.Single().Text);
    }

    [Fact]
    public void Parses_Function_Declaration()
    {
        const string source = @"
package P

func Main() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Equal("Main", fn.Identifier.Text);
    }

    [Fact]
    public void Reports_Diagnostic_On_Missing_Brace()
    {
        const string source = @"
package P

func Main() {
";
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void Tolerates_Missing_Package()
    {
        const string source = "func Main() {}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.NotNull(tree.Root);
    }

    [Fact]
    public void Parses_Switch_Expression()
    {
        const string source = @"
let v = 1
let x = switch v { case 1: ""a"" default: ""b"" }
";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(m => m.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single(v => v.Identifier.Text == "x");
        var expression = Assert.IsType<SwitchExpressionSyntax>(declaration.Initializer);
        Assert.Equal(2, expression.Arms.Length);
        Assert.Equal(SyntaxKind.ColonToken, expression.Arms[0].ArrowToken.Kind);
        Assert.True(expression.Arms[1].IsDefault);
    }

    [Fact]
    public void Parses_MemberAccess_On_Parenthesized_Expression()
    {
        var expression = ParseExpressionStatement("(a + b).GetType()\n");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(expression);
        Assert.IsType<ParenthesizedExpressionSyntax>(accessor.LeftPart);
        Assert.IsType<CallExpressionSyntax>(accessor.RightPart);
        Assert.False(accessor.IsNullConditional);
    }

    [Fact]
    public void Parses_MemberAccess_On_String_Literal()
    {
        var expression = ParseExpressionStatement("\"s\".Length\n");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(expression);
        Assert.IsType<LiteralExpressionSyntax>(accessor.LeftPart);
        var member = Assert.IsType<NameExpressionSyntax>(accessor.RightPart);
        Assert.Equal("Length", member.IdentifierToken.Text);
    }

    [Fact]
    public void Parses_Index_On_Parenthesized_Expression()
    {
        var expression = ParseExpressionStatement("(a + b)[0]\n");

        var index = Assert.IsType<IndexExpressionSyntax>(expression);
        Assert.IsType<ParenthesizedExpressionSyntax>(index.Target);
    }

    [Fact]
    public void Parses_NullConditional_On_Parenthesized_Expression()
    {
        var expression = ParseExpressionStatement("(a + b)?.x\n");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(expression);
        Assert.IsType<ParenthesizedExpressionSyntax>(accessor.LeftPart);
        Assert.True(accessor.IsNullConditional);
    }

    [Fact]
    public void Parses_MemberAccess_On_Switch_Expression()
    {
        const string source = "let r = switch v { case 1: \"a\" default: \"b\" }.ToString()\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(m => m.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single(v => v.Identifier.Text == "r");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(declaration.Initializer);
        Assert.IsType<SwitchExpressionSyntax>(accessor.LeftPart);
        Assert.IsType<CallExpressionSyntax>(accessor.RightPart);
    }

    [Fact]
    public void NumericLiteral_MemberAccess_Is_Not_Supported()
    {
        // Numeric literals are carved out of postfix chaining because `42.x`
        // collides with float-literal lexing; users must write `(42).x`.
        var tree = SyntaxTree.Parse("let x = 42.GetType()\n");
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void Parenthesized_NumericLiteral_MemberAccess_Is_Supported()
    {
        var expression = ParseExpressionStatement("(42).GetType()\n");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(expression);
        Assert.IsType<ParenthesizedExpressionSyntax>(accessor.LeftPart);
        Assert.IsType<CallExpressionSyntax>(accessor.RightPart);
    }

    [Fact]
    public void Parses_GeneralTernary_AsConditionalExpression()
    {
        // ADR-0062: `cond ? a : b` is a ConditionalExpressionSyntax.
        var expr = ParseExpressionStatement("true ? 1 : 2");
        var cond = Assert.IsType<ConditionalExpressionSyntax>(expr);
        Assert.IsType<LiteralExpressionSyntax>(cond.Condition);
        Assert.IsType<LiteralExpressionSyntax>(cond.WhenTrue);
        Assert.IsType<LiteralExpressionSyntax>(cond.WhenFalse);
    }

    [Fact]
    public void Ternary_IsRightAssociative()
    {
        // `a ? b : c ? d : e` parses as `a ? b : (c ? d : e)`.
        var expr = ParseExpressionStatement("true ? 1 : false ? 2 : 3");
        var outer = Assert.IsType<ConditionalExpressionSyntax>(expr);
        Assert.IsType<LiteralExpressionSyntax>(outer.WhenTrue);
        var inner = Assert.IsType<ConditionalExpressionSyntax>(outer.WhenFalse);
        Assert.IsType<LiteralExpressionSyntax>(inner.WhenTrue);
        Assert.IsType<LiteralExpressionSyntax>(inner.WhenFalse);
    }

    [Fact]
    public void Ternary_HasLowerPrecedenceThanLogicalOr()
    {
        // `a || b ? 1 : 2` parses as `(a || b) ? 1 : 2`.
        var expr = ParseExpressionStatement("true || false ? 1 : 2");
        var cond = Assert.IsType<ConditionalExpressionSyntax>(expr);
        Assert.IsType<BinaryExpressionSyntax>(cond.Condition);
    }

    [Fact]
    public void Ternary_LegacyInnerRef_StillRoutesToConditionalRefArg()
    {
        // ADR-0061 back-compat: `cond ? ref a : ref b` keeps producing the
        // legacy ConditionalRefArgumentExpressionSyntax for the binder.
        var expr = ParseExpressionStatement("true ? ref a : ref b");
        Assert.IsType<ConditionalRefArgumentExpressionSyntax>(expr);
    }

    [Fact]
    public void NonNullAssert_Standalone_WrapsOperandAsUnary()
    {
        // Issue #518 baseline: bare `a!!` (no chained continuation) keeps
        // producing a UnaryExpression so the existing emit/bind paths for
        // the simple form are unchanged.
        var expr = ParseExpressionStatement("a!!\n");
        var unary = Assert.IsType<UnaryExpressionSyntax>(expr);
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind);
        Assert.IsType<NameExpressionSyntax>(unary.Operand);
    }

    [Fact]
    public void NonNullAssert_ChainedMemberAccess_ParsesAsAccessorOnUnary()
    {
        // Issue #518 core repro: `a!!.b` must parse as `(a!!).b`, i.e. the
        // accessor's LeftPart is the `!!` UnaryExpression and the
        // RightPart is the member name.
        var expr = ParseExpressionStatement("a!!.b\n");
        var accessor = Assert.IsType<AccessorExpressionSyntax>(expr);
        Assert.False(accessor.IsNullConditional);
        var unary = Assert.IsType<UnaryExpressionSyntax>(accessor.LeftPart);
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind);
        Assert.IsType<NameExpressionSyntax>(unary.Operand);
        var rhs = Assert.IsType<NameExpressionSyntax>(accessor.RightPart);
        Assert.Equal("b", rhs.IdentifierToken.Text);
    }

    [Fact]
    public void NonNullAssert_ChainedNullConditional_ParsesAsNullConditionalAccessOnUnary()
    {
        // `a!!?.b` is admittedly redundant but the parser must still accept
        // it so the binder can reason about the resulting (non-nullable)
        // receiver. The accessor is null-conditional and its LeftPart is
        // the `!!` UnaryExpression.
        var expr = ParseExpressionStatement("a!!?.b\n");
        var accessor = Assert.IsType<AccessorExpressionSyntax>(expr);
        Assert.True(accessor.IsNullConditional);
        var unary = Assert.IsType<UnaryExpressionSyntax>(accessor.LeftPart);
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind);
    }

    [Fact]
    public void NonNullAssert_ChainedMethodCall_ParsesAsAccessorWithCallRightPart()
    {
        // `a!!.b()` follows the same accessor shape — LeftPart is the `!!`
        // UnaryExpression, RightPart is a CallExpression. This is the
        // shape ParsePostfixChain re-enters after consuming `!!`.
        var expr = ParseExpressionStatement("a!!.b()\n");
        var accessor = Assert.IsType<AccessorExpressionSyntax>(expr);
        Assert.IsType<UnaryExpressionSyntax>(accessor.LeftPart);
        Assert.IsType<CallExpressionSyntax>(accessor.RightPart);
    }

    [Fact]
    public void NonNullAssert_ChainedIndexer_ParsesAsIndexOnUnary()
    {
        // `a!![0]` — postfix indexer applied to the `!!`-wrapped value.
        // The IndexExpression's Target is the UnaryExpression.
        var expr = ParseExpressionStatement("a!![0]\n");
        var index = Assert.IsType<IndexExpressionSyntax>(expr);
        var unary = Assert.IsType<UnaryExpressionSyntax>(index.Target);
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind);
    }

    [Fact]
    public void NonNullAssert_FollowedByBinaryOperator_BindsAsLeftOperand()
    {
        // `a!! + b` — `!!` is the tightest postfix so the BinaryExpression's
        // Left is the UnaryExpression, not the bare name. This is the
        // existing behavior; the test guards against accidental regression.
        var expr = ParseExpressionStatement("a!! + b\n");
        var binary = Assert.IsType<BinaryExpressionSyntax>(expr);
        Assert.Equal(SyntaxKind.PlusToken, binary.OperatorToken.Kind);
        var leftUnary = Assert.IsType<UnaryExpressionSyntax>(binary.Left);
        Assert.Equal(SyntaxKind.BangBangToken, leftUnary.OperatorToken.Kind);
    }

    [Fact]
    public void NonNullAssert_FollowedByEquality_ParsesAsBinaryOfUnary()
    {
        // Same shape as `+` but with `==`. Confirms the comparison
        // operators see the `!!`-wrapped value on the left.
        var expr = ParseExpressionStatement("a!! == b\n");
        var binary = Assert.IsType<BinaryExpressionSyntax>(expr);
        Assert.Equal(SyntaxKind.EqualsEqualsToken, binary.OperatorToken.Kind);
        Assert.IsType<UnaryExpressionSyntax>(binary.Left);
    }

    [Fact]
    public void NonNullAssert_Chained_DoubleAssert_WithIntermediateMember()
    {
        // `a!!.b!!.c` — the tightest grouping is `((a!!).b)!!).c`. After
        // the first `!!` we re-enter the postfix chain and consume `.b`,
        // then the second `!!` wraps that accessor, then `.c` is consumed
        // by the postfix re-entry. The result is an accessor whose
        // LeftPart is a UnaryExpression whose operand is another accessor
        // whose LeftPart is itself a UnaryExpression on `a`.
        var expr = ParseExpressionStatement("a!!.b!!.c\n");
        var outerAccessor = Assert.IsType<AccessorExpressionSyntax>(expr);
        Assert.Equal("c", Assert.IsType<NameExpressionSyntax>(outerAccessor.RightPart).IdentifierToken.Text);
        var outerUnary = Assert.IsType<UnaryExpressionSyntax>(outerAccessor.LeftPart);
        Assert.Equal(SyntaxKind.BangBangToken, outerUnary.OperatorToken.Kind);
        var innerAccessor = Assert.IsType<AccessorExpressionSyntax>(outerUnary.Operand);
        Assert.Equal("b", Assert.IsType<NameExpressionSyntax>(innerAccessor.RightPart).IdentifierToken.Text);
        var innerUnary = Assert.IsType<UnaryExpressionSyntax>(innerAccessor.LeftPart);
        Assert.Equal(SyntaxKind.BangBangToken, innerUnary.OperatorToken.Kind);
        Assert.Equal("a", Assert.IsType<NameExpressionSyntax>(innerUnary.Operand).IdentifierToken.Text);
    }

    [Fact]
    public void NonNullAssert_OnMemberAccessReceiver_ChainsContinuingMember()
    {
        // The issue's reduced repro: `dir.Parent!!.Name`. The parser must
        // produce `((dir.Parent)!!).Name` — an outer accessor whose
        // LeftPart is a UnaryExpression wrapping the inner `dir.Parent`
        // accessor, and whose RightPart is the `Name` member.
        var expr = ParseExpressionStatement("dir.Parent!!.Name\n");
        var outerAccessor = Assert.IsType<AccessorExpressionSyntax>(expr);
        Assert.Equal("Name", Assert.IsType<NameExpressionSyntax>(outerAccessor.RightPart).IdentifierToken.Text);
        var unary = Assert.IsType<UnaryExpressionSyntax>(outerAccessor.LeftPart);
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind);
        var innerAccessor = Assert.IsType<AccessorExpressionSyntax>(unary.Operand);
        Assert.Equal("dir", Assert.IsType<NameExpressionSyntax>(innerAccessor.LeftPart).IdentifierToken.Text);
        Assert.Equal("Parent", Assert.IsType<NameExpressionSyntax>(innerAccessor.RightPart).IdentifierToken.Text);
    }

    private static ExpressionSyntax ParseExpressionStatement(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var statement = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(m => m.Statement)
            .OfType<ExpressionStatementSyntax>()
            .First();
        return statement.Expression;
    }
}
