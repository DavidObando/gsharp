// <copyright file="Issue4350IndexRangeSyntaxTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0187 / issue #4350: prefix `^x` parses as a first-class
/// (cref:FromEndIndexExpressionSyntax) in every expression context at
/// unary precedence, `~x` is the one's-complement unary operator, and
/// binary `^` stays XOR.
open class Issue4350IndexRangeSyntaxTests {
    @Fact
    func Lexer_ProducesTildeToken() {
        let tokens = SyntaxTree.ParseTokens("~x")
        Assert.Equal(SyntaxKind.TildeToken, tokens[0].Kind)
        Assert.Equal("~", SyntaxFacts.GetText(SyntaxKind.TildeToken))
    }

    @Fact
    func PrefixHat_IsFromEndIndex_InLocalInitializer() {
        let fromEnd = Assert.IsType[FromEndIndexExpressionSyntax](GetInitializer("let last = ^1"))
        Assert.Equal(SyntaxKind.HatToken, fromEnd.HatToken.Kind)
        Assert.IsType[LiteralExpressionSyntax](fromEnd.Operand)
    }

    @Fact
    func PrefixHat_IsFromEndIndex_InArgumentPosition() {
        let call = Assert.IsType[CallExpressionSyntax](GetInitializer("let x = consume(^2, ^n)"))
        Assert.All(call.Arguments, (argument ExpressionSyntax) -> Assert.IsType[FromEndIndexExpressionSyntax](argument))
    }

    @Fact
    func PrefixHat_BindsAtUnaryPrecedence() {
        // `^a + 1` is `(^a) + 1`, exactly as in C#.
        let binary = Assert.IsType[BinaryExpressionSyntax](GetInitializer("let x = ^a + 1"))
        Assert.IsType[FromEndIndexExpressionSyntax](binary.Left)
        Assert.Equal(SyntaxKind.PlusToken, binary.OperatorToken.Kind)
        // Postfix member access binds tighter: `^a.b` is `^(a.b)`.
        let member = Assert.IsType[FromEndIndexExpressionSyntax](GetInitializer("let y = ^a.b"))
        Assert.IsNotType[NameExpressionSyntax](member.Operand)
    }

    @Fact
    func ParenthesizedPrefixHat_IsStillFromEndIndex() {
        let parenthesized = Assert.IsType[ParenthesizedExpressionSyntax](GetInitializer("let x = (^n)"))
        Assert.IsType[FromEndIndexExpressionSyntax](parenthesized.Expression)
    }

    @Fact
    func StandaloneRange_AcceptsLeadingFromEndBound() {
        let range_ = Assert.IsType[RangeExpressionSyntax](GetInitializer("let r = ^4..^1"))
        Assert.IsType[FromEndIndexExpressionSyntax](range_.LowerBound)
        Assert.IsType[FromEndIndexExpressionSyntax](range_.UpperBound)
        let tail = Assert.IsType[RangeExpressionSyntax](GetInitializer("let r = ^3.."))
        Assert.IsType[FromEndIndexExpressionSyntax](tail.LowerBound)
        Assert.Null(tail.UpperBound)
    }

    @Fact
    func Tilde_IsUnaryOnesComplement() {
        let unary = Assert.IsType[UnaryExpressionSyntax](GetInitializer("let x = ~mask"))
        Assert.Equal(SyntaxKind.TildeToken, unary.OperatorToken.Kind)
    }

    @Fact
    func TildeInsideIndexBracket_StaysOnesComplement() {
        let index = Assert.IsType[IndexExpressionSyntax](GetInitializer("let x = a[~i]"))
        let unary = Assert.IsType[UnaryExpressionSyntax](index.Index)
        Assert.Equal(SyntaxKind.TildeToken, unary.OperatorToken.Kind)
    }

    @Fact
    func BinaryHat_StaysXor() {
        let binary = Assert.IsType[BinaryExpressionSyntax](GetInitializer("let x = a ^ b"))
        Assert.Equal(SyntaxKind.HatToken, binary.OperatorToken.Kind)
    }

    @Fact
    func TildeOperatorDeclaration_MapsToOnesComplementName() {
        let tree = SyntaxTree.Parse(`package P
struct Bits(Value int32) {
}
func (a Bits) operator ~() Bits -> Bits{Value: ~a.Value}`)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Equal("op_OnesComplement", function.Identifier.Text)
    }

    shared {
        private func GetInitializer(statement string) ExpressionSyntax? {
            let tree = SyntaxTree.Parse("package P\n" + statement)
            Assert.Empty(tree.Diagnostics)
            let declaration = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return declaration.Initializer
        }
    }
}
