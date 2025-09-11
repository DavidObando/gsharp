// <copyright file="SyntaxFactsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Syntax
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Syntax;
    using Xunit;

    public class SyntaxFactsTests
    {
        [Theory]
        [InlineData(SyntaxKind.TrueKeyword, "true")]
        [InlineData(SyntaxKind.FalseKeyword, "false")]
        [InlineData(SyntaxKind.IfKeyword, "if")]
        [InlineData(SyntaxKind.ElseKeyword, "else")]
        [InlineData(SyntaxKind.ForKeyword, "for")]
        [InlineData(SyntaxKind.BreakKeyword, "break")]
        [InlineData(SyntaxKind.ContinueKeyword, "continue")]
        [InlineData(SyntaxKind.FuncKeyword, "func")]
        [InlineData(SyntaxKind.VarKeyword, "var")]
        [InlineData(SyntaxKind.ReturnKeyword, "return")]
        public void GetText_Keywords_ReturnsCorrectText(SyntaxKind kind, string expectedText)
        {
            var text = SyntaxFacts.GetText(kind);
            text.Should().Be(expectedText);
        }

        [Theory]
        [InlineData(SyntaxKind.PlusToken, "+")]
        [InlineData(SyntaxKind.MinusToken, "-")]
        [InlineData(SyntaxKind.StarToken, "*")]
        [InlineData(SyntaxKind.SlashToken, "/")]
        [InlineData(SyntaxKind.EqualsToken, "=")]
        [InlineData(SyntaxKind.EqualsEqualsToken, "==")]
        [InlineData(SyntaxKind.BangEqualsToken, "!=")]
        [InlineData(SyntaxKind.LessToken, "<")]
        [InlineData(SyntaxKind.GreaterToken, ">")]
        [InlineData(SyntaxKind.LessOrEqualsToken, "<=")]
        [InlineData(SyntaxKind.GreaterOrEqualsToken, ">=")]
        [InlineData(SyntaxKind.AmpersandAmpersandToken, "&&")]
        [InlineData(SyntaxKind.PipePipeToken, "||")]
        [InlineData(SyntaxKind.BangToken, "!")]
        [InlineData(SyntaxKind.AmpersandToken, "&")]
        [InlineData(SyntaxKind.PipeToken, "|")]
        [InlineData(SyntaxKind.HatToken, "^")]
        [InlineData(SyntaxKind.CommaToken, ",")]
        [InlineData(SyntaxKind.ColonToken, ":")]
        [InlineData(SyntaxKind.SemicolonToken, ";")]
        [InlineData(SyntaxKind.OpenParenthesisToken, "(")]
        [InlineData(SyntaxKind.CloseParenthesisToken, ")")]
        [InlineData(SyntaxKind.OpenBraceToken, "{")]
        [InlineData(SyntaxKind.CloseBraceToken, "}")]
        public void SyntaxFacts_GetText_ReturnsCorrectText(SyntaxKind kind, string expectedText)
        {
            var text = SyntaxFacts.GetText(kind);
            text.Should().Be(expectedText);
        }

        [Theory]
        [InlineData(SyntaxKind.PlusToken, 4)]
        [InlineData(SyntaxKind.MinusToken, 4)]
        [InlineData(SyntaxKind.StarToken, 5)]
        [InlineData(SyntaxKind.SlashToken, 5)]
        public void SyntaxFacts_GetBinaryOperatorPrecedence_ReturnsCorrectPrecedence(SyntaxKind kind, int expectedPrecedence)
        {
            var precedence = SyntaxFacts.GetBinaryOperatorPrecedence(kind);
            precedence.Should().Be(expectedPrecedence);
        }

        [Theory]
        [InlineData(SyntaxKind.PlusToken, 6)]
        [InlineData(SyntaxKind.MinusToken, 6)]
        [InlineData(SyntaxKind.BangToken, 6)]
        public void SyntaxFacts_GetUnaryOperatorPrecedence_ReturnsCorrectPrecedence(SyntaxKind kind, int expectedPrecedence)
        {
            var precedence = SyntaxFacts.GetUnaryOperatorPrecedence(kind);
            precedence.Should().Be(expectedPrecedence);
        }

        [Theory]
        [InlineData(SyntaxKind.IdentifierToken)]
        [InlineData(SyntaxKind.NumberToken)]
        [InlineData(SyntaxKind.StringToken)]
        [InlineData(SyntaxKind.WhitespaceToken)]
        public void SyntaxFacts_GetText_ReturnsNullForNonFixedTokens(SyntaxKind kind)
        {
            var text = SyntaxFacts.GetText(kind);
            text.Should().BeNull();
        }

        [Fact]
        public void SyntaxFacts_GetText_WithNonExistentKind_ReturnsNull()
        {
            var text = SyntaxFacts.GetText((SyntaxKind)9999);
            text.Should().BeNull();
        }

        [Theory]
        [InlineData(SyntaxKind.PlusToken, true)]
        [InlineData(SyntaxKind.MinusToken, true)]
        [InlineData(SyntaxKind.StarToken, true)]
        [InlineData(SyntaxKind.SlashToken, true)]
        [InlineData(SyntaxKind.EqualsEqualsToken, true)]
        [InlineData(SyntaxKind.BangEqualsToken, true)]
        [InlineData(SyntaxKind.LessToken, true)]
        [InlineData(SyntaxKind.GreaterToken, true)]
        [InlineData(SyntaxKind.LessOrEqualsToken, true)]
        [InlineData(SyntaxKind.GreaterOrEqualsToken, true)]
        [InlineData(SyntaxKind.AmpersandAmpersandToken, true)]
        [InlineData(SyntaxKind.PipePipeToken, true)]
        [InlineData(SyntaxKind.AmpersandToken, true)]
        [InlineData(SyntaxKind.PipeToken, true)]
        [InlineData(SyntaxKind.HatToken, true)]
        [InlineData(SyntaxKind.IdentifierToken, false)]
        [InlineData(SyntaxKind.NumberToken, false)]
        [InlineData(SyntaxKind.StringToken, false)]
        public void SyntaxFacts_GetBinaryOperatorPrecedence_ReturnsPrecedenceForBinaryOperators(SyntaxKind kind, bool shouldHavePrecedence)
        {
            var precedence = SyntaxFacts.GetBinaryOperatorPrecedence(kind);
            
            if (shouldHavePrecedence)
            {
                precedence.Should().BeGreaterThan(0);
            }
            else
            {
                precedence.Should().Be(0);
            }
        }

        [Theory]
        [InlineData(SyntaxKind.PlusToken, true)]
        [InlineData(SyntaxKind.MinusToken, true)]
        [InlineData(SyntaxKind.BangToken, true)]
        [InlineData(SyntaxKind.StarToken, true)]
        [InlineData(SyntaxKind.SlashToken, false)]
        [InlineData(SyntaxKind.IdentifierToken, false)]
        public void SyntaxFacts_GetUnaryOperatorPrecedence_ReturnsPrecedenceForUnaryOperators(SyntaxKind kind, bool shouldHavePrecedence)
        {
            var precedence = SyntaxFacts.GetUnaryOperatorPrecedence(kind);
            
            if (shouldHavePrecedence)
            {
                precedence.Should().BeGreaterThan(0);
            }
            else
            {
                precedence.Should().Be(0);
            }
        }
    }
}
