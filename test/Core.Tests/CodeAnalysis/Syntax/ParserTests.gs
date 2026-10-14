// <copyright file="ParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

open class ParserTests {
    @Fact
    func Parses_HelloWorld_Sample_Without_Diagnostics() {
        const source = `
package HelloWorld

import System

Console.WriteLine("Hello, world!")
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotNull(tree.Root)
        let pkg = tree.Root.Members.OfType[PackageSyntax]().Single()
        Assert.Equal("HelloWorld", pkg.Identifiers.Single().Text)
    }

    @Fact
    func Parses_Function_Declaration() {
        const source = `
package P

func Main() {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Equal("Main", fn.Identifier.Text)
    }

    @Fact
    func Reports_Diagnostic_On_Missing_Brace() {
        const source = `
package P

func Main() {
`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }

    @Fact
    func Tolerates_Missing_Package() {
        const source = "func Main() {}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.NotNull(tree.Root)
    }

    @Fact
    func Parses_Switch_Expression() {
        const source = `
let v = 1
let x = switch v { case 1: "a" default: "b" }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let declaration = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((m GlobalStatementSyntax) -> m.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single((v VariableDeclarationSyntax) -> v.Identifier.Text == "x")
        let expression = Assert.IsType[SwitchExpressionSyntax](declaration.Initializer)
        Assert.Equal(2, expression.Arms.Length)
        Assert.Equal(SyntaxKind.ColonToken, expression.Arms[0].ArrowToken.Kind)
        Assert.True(expression.Arms[1].IsDefault)
    }

    @Fact
    func Parses_MemberAccess_On_Parenthesized_Expression() {
        let expression = ParseExpressionStatement("(a + b).GetType()\n")
        let accessor = Assert.IsType[AccessorExpressionSyntax](expression)
        Assert.IsType[ParenthesizedExpressionSyntax](accessor.LeftPart)
        Assert.IsType[CallExpressionSyntax](accessor.RightPart)
        Assert.False(accessor.IsNullConditional)
    }

    @Fact
    func Parses_MemberAccess_On_String_Literal() {
        let expression = ParseExpressionStatement("\"s\".Length\n")
        let accessor = Assert.IsType[AccessorExpressionSyntax](expression)
        Assert.IsType[LiteralExpressionSyntax](accessor.LeftPart)
        let member = Assert.IsType[NameExpressionSyntax](accessor.RightPart)
        Assert.Equal("Length", member.IdentifierToken.Text)
    }

    @Fact
    func Parses_Index_On_Parenthesized_Expression() {
        let expression = ParseExpressionStatement("(a + b)[0]\n")
        let index = Assert.IsType[IndexExpressionSyntax](expression)
        Assert.IsType[ParenthesizedExpressionSyntax](index.Target)
    }

    @Fact
    func Parses_NullConditional_On_Parenthesized_Expression() {
        let expression = ParseExpressionStatement("(a + b)?.x\n")
        let accessor = Assert.IsType[AccessorExpressionSyntax](expression)
        Assert.IsType[ParenthesizedExpressionSyntax](accessor.LeftPart)
        Assert.True(accessor.IsNullConditional)
    }

    @Fact
    func Parses_MemberAccess_On_Switch_Expression() {
        const source = "let r = switch v { case 1: \"a\" default: \"b\" }.ToString()\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let declaration = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((m GlobalStatementSyntax) -> m.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single((v VariableDeclarationSyntax) -> v.Identifier.Text == "r")
        let accessor = Assert.IsType[AccessorExpressionSyntax](declaration.Initializer)
        Assert.IsType[SwitchExpressionSyntax](accessor.LeftPart)
        Assert.IsType[CallExpressionSyntax](accessor.RightPart)
    }

    @Fact
    func NumericLiteral_MemberAccess_Is_Not_Supported() {
        // Numeric literals are carved out of postfix chaining because `42.x`
        // collides with float-literal lexing; users must write `(42).x`.
        let tree = SyntaxTree.Parse("let x = 42.GetType()\n")
        Assert.NotEmpty(tree.Diagnostics)
    }

    @Fact
    func Parenthesized_NumericLiteral_MemberAccess_Is_Supported() {
        let expression = ParseExpressionStatement("(42).GetType()\n")
        let accessor = Assert.IsType[AccessorExpressionSyntax](expression)
        Assert.IsType[ParenthesizedExpressionSyntax](accessor.LeftPart)
        Assert.IsType[CallExpressionSyntax](accessor.RightPart)
    }

    @Fact
    func Parses_GeneralTernary_AsConditionalExpression() {
        // ADR-0062: `cond ? a : b` is a ConditionalExpressionSyntax.
        let expr = ParseExpressionStatement("true ? 1 : 2")
        let cond = Assert.IsType[ConditionalExpressionSyntax](expr)
        Assert.IsType[LiteralExpressionSyntax](cond.Condition)
        Assert.IsType[LiteralExpressionSyntax](cond.WhenTrue)
        Assert.IsType[LiteralExpressionSyntax](cond.WhenFalse)
    }

    @Fact
    func Ternary_IsRightAssociative() {
        // `a ? b : c ? d : e` parses as `a ? b : (c ? d : e)`.
        let expr = ParseExpressionStatement("true ? 1 : false ? 2 : 3")
        let outer = Assert.IsType[ConditionalExpressionSyntax](expr)
        Assert.IsType[LiteralExpressionSyntax](outer.WhenTrue)
        let inner = Assert.IsType[ConditionalExpressionSyntax](outer.WhenFalse)
        Assert.IsType[LiteralExpressionSyntax](inner.WhenTrue)
        Assert.IsType[LiteralExpressionSyntax](inner.WhenFalse)
    }

    @Fact
    func Ternary_HasLowerPrecedenceThanLogicalOr() {
        // `a || b ? 1 : 2` parses as `(a || b) ? 1 : 2`.
        let expr = ParseExpressionStatement("true || false ? 1 : 2")
        let cond = Assert.IsType[ConditionalExpressionSyntax](expr)
        Assert.IsType[BinaryExpressionSyntax](cond.Condition)
    }

    @Fact
    func Ternary_LegacyInnerRef_StillRoutesToConditionalRefArg() {
        // ADR-0061 back-compat: `cond ? ref a : ref b` keeps producing the
        // legacy ConditionalRefArgumentExpressionSyntax for the binder.
        let expr = ParseExpressionStatement("true ? ref a : ref b")
        Assert.IsType[ConditionalRefArgumentExpressionSyntax](expr)
    }

    @Fact
    func NonNullAssert_Standalone_WrapsOperandAsUnary() {
        // Issue #518 baseline: bare `a!!` (no chained continuation) keeps
        // producing a UnaryExpression so the existing emit/bind paths for
        // the simple form are unchanged.
        let expr = ParseExpressionStatement("a!!\n")
        let unary = Assert.IsType[UnaryExpressionSyntax](expr)
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind)
        Assert.IsType[NameExpressionSyntax](unary.Operand)
    }

    @Fact
    func NonNullAssert_ChainedMemberAccess_ParsesAsAccessorOnUnary() {
        // Issue #518 core repro: `a!!.b` must parse as `(a!!).b`, i.e. the
        // accessor's LeftPart is the `!!` UnaryExpression and the
        // RightPart is the member name.
        let expr = ParseExpressionStatement("a!!.b\n")
        let accessor = Assert.IsType[AccessorExpressionSyntax](expr)
        Assert.False(accessor.IsNullConditional)
        let unary = Assert.IsType[UnaryExpressionSyntax](accessor.LeftPart)
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind)
        Assert.IsType[NameExpressionSyntax](unary.Operand)
        let rhs = Assert.IsType[NameExpressionSyntax](accessor.RightPart)
        Assert.Equal("b", rhs.IdentifierToken.Text)
    }

    @Fact
    func NonNullAssert_ChainedNullConditional_ParsesAsNullConditionalAccessOnUnary() {
        // `a!!?.b` is admittedly redundant but the parser must still accept
        // it so the binder can reason about the resulting (non-nullable)
        // receiver. The accessor is null-conditional and its LeftPart is
        // the `!!` UnaryExpression.
        let expr = ParseExpressionStatement("a!!?.b\n")
        let accessor = Assert.IsType[AccessorExpressionSyntax](expr)
        Assert.True(accessor.IsNullConditional)
        let unary = Assert.IsType[UnaryExpressionSyntax](accessor.LeftPart)
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind)
    }

    @Fact
    func NonNullAssert_ChainedMethodCall_ParsesAsAccessorWithCallRightPart() {
        // `a!!.b()` follows the same accessor shape — LeftPart is the `!!`
        // UnaryExpression, RightPart is a CallExpression. This is the
        // shape ParsePostfixChain re-enters after consuming `!!`.
        let expr = ParseExpressionStatement("a!!.b()\n")
        let accessor = Assert.IsType[AccessorExpressionSyntax](expr)
        Assert.IsType[UnaryExpressionSyntax](accessor.LeftPart)
        Assert.IsType[CallExpressionSyntax](accessor.RightPart)
    }

    @Fact
    func NonNullAssert_ChainedIndexer_ParsesAsIndexOnUnary() {
        // `a!![0]` — postfix indexer applied to the `!!`-wrapped value.
        // The IndexExpression's Target is the UnaryExpression.
        let expr = ParseExpressionStatement("a!![0]\n")
        let index = Assert.IsType[IndexExpressionSyntax](expr)
        let unary = Assert.IsType[UnaryExpressionSyntax](index.Target)
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind)
    }

    @Fact
    func NonNullAssert_FollowedByBinaryOperator_BindsAsLeftOperand() {
        // `a!! + b` — `!!` is the tightest postfix so the BinaryExpression's
        // Left is the UnaryExpression, not the bare name. This is the
        // existing behavior; the test guards against accidental regression.
        let expr = ParseExpressionStatement("a!! + b\n")
        let binary = Assert.IsType[BinaryExpressionSyntax](expr)
        Assert.Equal(SyntaxKind.PlusToken, binary.OperatorToken.Kind)
        let leftUnary = Assert.IsType[UnaryExpressionSyntax](binary.Left)
        Assert.Equal(SyntaxKind.BangBangToken, leftUnary.OperatorToken.Kind)
    }

    @Fact
    func NonNullAssert_FollowedByEquality_ParsesAsBinaryOfUnary() {
        // Same shape as `+` but with `==`. Confirms the comparison
        // operators see the `!!`-wrapped value on the left.
        let expr = ParseExpressionStatement("a!! == b\n")
        let binary = Assert.IsType[BinaryExpressionSyntax](expr)
        Assert.Equal(SyntaxKind.EqualsEqualsToken, binary.OperatorToken.Kind)
        Assert.IsType[UnaryExpressionSyntax](binary.Left)
    }

    @Fact
    func NonNullAssert_Chained_DoubleAssert_WithIntermediateMember() {
        // `a!!.b!!.c` — the tightest grouping is `((a!!).b)!!).c`. After
        // the first `!!` we re-enter the postfix chain and consume `.b`,
        // then the second `!!` wraps that accessor, then `.c` is consumed
        // by the postfix re-entry. The result is an accessor whose
        // LeftPart is a UnaryExpression whose operand is another accessor
        // whose LeftPart is itself a UnaryExpression on `a`.
        let expr = ParseExpressionStatement("a!!.b!!.c\n")
        let outerAccessor = Assert.IsType[AccessorExpressionSyntax](expr)
        Assert.Equal("c", Assert.IsType[NameExpressionSyntax](outerAccessor.RightPart).IdentifierToken.Text)
        let outerUnary = Assert.IsType[UnaryExpressionSyntax](outerAccessor.LeftPart)
        Assert.Equal(SyntaxKind.BangBangToken, outerUnary.OperatorToken.Kind)
        let innerAccessor = Assert.IsType[AccessorExpressionSyntax](outerUnary.Operand)
        Assert.Equal("b", Assert.IsType[NameExpressionSyntax](innerAccessor.RightPart).IdentifierToken.Text)
        let innerUnary = Assert.IsType[UnaryExpressionSyntax](innerAccessor.LeftPart)
        Assert.Equal(SyntaxKind.BangBangToken, innerUnary.OperatorToken.Kind)
        Assert.Equal("a", Assert.IsType[NameExpressionSyntax](innerUnary.Operand).IdentifierToken.Text)
    }

    @Fact
    func NonNullAssert_OnMemberAccessReceiver_ChainsContinuingMember() {
        // The issue's reduced repro: `dir.Parent!!.Name`. The parser must
        // produce `((dir.Parent)!!).Name` — an outer accessor whose
        // LeftPart is a UnaryExpression wrapping the inner `dir.Parent`
        // accessor, and whose RightPart is the `Name` member.
        let expr = ParseExpressionStatement("dir.Parent!!.Name\n")
        let outerAccessor = Assert.IsType[AccessorExpressionSyntax](expr)
        Assert.Equal("Name", Assert.IsType[NameExpressionSyntax](outerAccessor.RightPart).IdentifierToken.Text)
        let unary = Assert.IsType[UnaryExpressionSyntax](outerAccessor.LeftPart)
        Assert.Equal(SyntaxKind.BangBangToken, unary.OperatorToken.Kind)
        let innerAccessor = Assert.IsType[AccessorExpressionSyntax](unary.Operand)
        Assert.Equal("dir", Assert.IsType[NameExpressionSyntax](innerAccessor.LeftPart).IdentifierToken.Text)
        Assert.Equal("Parent", Assert.IsType[NameExpressionSyntax](innerAccessor.RightPart).IdentifierToken.Text)
    }

    shared {
        private func ParseExpressionStatement(source string) ExpressionSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let statement = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((m GlobalStatementSyntax) -> m.Statement)
                .OfType[ExpressionStatementSyntax]()
                .First()
            return statement.Expression
        }
    }
}
