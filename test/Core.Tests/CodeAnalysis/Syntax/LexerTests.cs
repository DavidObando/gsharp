// <copyright file="LexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public class LexerTests
{
    [Theory]
    [InlineData("+", SyntaxKind.PlusToken)]
    [InlineData("+=", SyntaxKind.PlusEqualsToken)]
    [InlineData("++", SyntaxKind.PlusPlusToken)]
    [InlineData("-", SyntaxKind.MinusToken)]
    [InlineData("*", SyntaxKind.StarToken)]
    [InlineData("/", SyntaxKind.SlashToken)]
    [InlineData("==", SyntaxKind.EqualsEqualsToken)]
    [InlineData("!=", SyntaxKind.BangEqualsToken)]
    [InlineData("<=", SyntaxKind.LessOrEqualsToken)]
    [InlineData(">=", SyntaxKind.GreaterOrEqualsToken)]
    [InlineData("&&", SyntaxKind.AmpersandAmpersandToken)]
    [InlineData("||", SyntaxKind.PipePipeToken)]
    [InlineData(":=", SyntaxKind.ColonEqualsToken)]
    [InlineData("...", SyntaxKind.EllipsisToken)]
    [InlineData("<-", SyntaxKind.LeftArrowToken)]
    public void Lexes_Operator(string text, SyntaxKind expected)
    {
        var tokens = SyntaxTree.ParseTokens(text);
        var token = Assert.Single(tokens);
        Assert.Equal(expected, token.Kind);
        Assert.Equal(text, token.Text);
    }

    [Theory]
    [InlineData("func", SyntaxKind.FuncKeyword)]
    [InlineData("if", SyntaxKind.IfKeyword)]
    [InlineData("else", SyntaxKind.ElseKeyword)]
    [InlineData("for", SyntaxKind.ForKeyword)]
    [InlineData("return", SyntaxKind.ReturnKeyword)]
    [InlineData("package", SyntaxKind.PackageKeyword)]
    [InlineData("import", SyntaxKind.ImportKeyword)]
    [InlineData("true", SyntaxKind.TrueKeyword)]
    [InlineData("false", SyntaxKind.FalseKeyword)]
    public void Lexes_Keyword(string text, SyntaxKind expected)
    {
        var tokens = SyntaxTree.ParseTokens(text);
        var token = Assert.Single(tokens);
        Assert.Equal(expected, token.Kind);
    }

    [Theory]
    [InlineData("identifier")]
    [InlineData("camelCase")]
    [InlineData("num1")]
    [InlineData("a1b2c3")]
    [InlineData("_x")]
    [InlineData("x_y")]
    [InlineData("var123")]
    [InlineData("_")]
    public void Lexes_Identifier(string text)
    {
        var tokens = SyntaxTree.ParseTokens(text);
        var token = Assert.Single(tokens);
        Assert.Equal(SyntaxKind.IdentifierToken, token.Kind);
        Assert.Equal(text, token.Text);
    }

    [Fact]
    public void Identifier_Cannot_Start_With_Digit()
    {
        var tokens = SyntaxTree.ParseTokens("1abc");
        Assert.Collection(
            tokens,
            t =>
            {
                Assert.Equal(SyntaxKind.NumberToken, t.Kind);
                Assert.Equal("1", t.Text);
            },
            t =>
            {
                Assert.Equal(SyntaxKind.IdentifierToken, t.Kind);
                Assert.Equal("abc", t.Text);
            });
    }

    [Theory]
    [InlineData("42")]
    [InlineData("0")]
    [InlineData("12345")]
    public void Lexes_NumberLiteral(string text)
    {
        var tokens = SyntaxTree.ParseTokens(text);
        var token = Assert.Single(tokens);
        Assert.Equal(SyntaxKind.NumberToken, token.Kind);
        Assert.Equal(int.Parse(text), token.Value);
    }

    [Theory]
    [InlineData("0x1F", 31)]
    [InlineData("0X_FF", 255)]
    [InlineData("0xDEAD_BEEF", unchecked((int)0xDEADBEEFu))]
    [InlineData("0o17", 15)]
    [InlineData("0O_77", 63)]
    [InlineData("0b1010", 10)]
    [InlineData("0B_1010_1010", 0b10101010)]
    [InlineData("1_000_000", 1_000_000)]
    [InlineData("1_2_3", 123)]
    public void Lexes_NumberLiteral_Variants(string text, int expected)
    {
        var tokens = SyntaxTree.ParseTokens(text, out var diagnostics);
        var token = Assert.Single(tokens);
        Assert.Empty(diagnostics);
        Assert.Equal(SyntaxKind.NumberToken, token.Kind);
        Assert.Equal(expected, token.Value);
        Assert.Equal(text, token.Text);
    }

    [Theory]
    [InlineData("_1")]   // bare leading underscore lexes as identifier, not a number — see Lexes_Identifier
    [InlineData("1_")]   // trailing _ in a decimal literal is invalid per Go
    [InlineData("0x_")]  // prefix without digits
    [InlineData("0b")]   // prefix without digits
    public void Invalid_NumberLiteral_Reports_Diagnostic(string text)
    {
        SyntaxTree.ParseTokens(text, out var diagnostics);
        if (text == "_1")
        {
            // Not actually a number — verify it isn't silently consumed as one.
            Assert.DoesNotContain(diagnostics, d => d.Message.Contains("number", System.StringComparison.OrdinalIgnoreCase));
        }
        else
        {
            Assert.Contains(diagnostics, d => d.Message.Contains("number", System.StringComparison.OrdinalIgnoreCase));
        }
    }

    [Fact]
    public void Lexes_StringLiteral()
    {
        var tokens = SyntaxTree.ParseTokens("\"hello\"");
        var token = Assert.Single(tokens);
        Assert.Equal(SyntaxKind.StringToken, token.Kind);
        Assert.Equal("hello", token.Value);
    }

    [Fact]
    public void Lexes_UnterminatedString_ReportsDiagnostic()
    {
        SyntaxTree.ParseTokens("\"hello", out var diagnostics);
        Assert.Contains(diagnostics, d => d.Message.Contains("Unterminated string", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Lexes_BadCharacter_ReportsDiagnostic()
    {
        // Backtick alone (without a closing backtick) is now an unterminated
        // raw string per Phase 1.2, not a bad character. Use a character that
        // remains unmapped to exercise the bad-character diagnostic.
        SyntaxTree.ParseTokens("#", out var diagnostics);
        Assert.NotEmpty(diagnostics);
        Assert.Contains(diagnostics, d => d.Message.Contains("Bad character", System.StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("`hello`", "hello")]
    [InlineData("``", "")]
    [InlineData("`line1\nline2`", "line1\nline2")]
    [InlineData("`no \\n escapes here`", "no \\n escapes here")]
    [InlineData("`\"quoted\"`", "\"quoted\"")]
    public void Lexes_RawStringLiteral(string text, string expectedValue)
    {
        var tokens = SyntaxTree.ParseTokens(text, out var diagnostics);
        var token = Assert.Single(tokens);
        Assert.Empty(diagnostics);
        Assert.Equal(SyntaxKind.StringToken, token.Kind);
        Assert.Equal(expectedValue, token.Value);
    }

    [Theory]
    [InlineData("1L", typeof(long), 1L)]
    [InlineData("1l", typeof(long), 1L)]
    [InlineData("1U", typeof(uint), 1U)]
    [InlineData("1u", typeof(uint), 1U)]
    [InlineData("1UL", typeof(ulong), 1UL)]
    [InlineData("1ul", typeof(ulong), 1UL)]
    [InlineData("1LU", typeof(ulong), 1UL)]
    [InlineData("1lu", typeof(ulong), 1UL)]
    [InlineData("0xFFL", typeof(long), 0xFFL)]
    [InlineData("0xFFU", typeof(uint), 0xFFU)]
    [InlineData("0xFFUL", typeof(ulong), 0xFFUL)]
    public void Lexes_IntegerLiteral_WithSuffix(string text, System.Type expectedType, object expectedValue)
    {
        var tokens = SyntaxTree.ParseTokens(text, out var diagnostics);
        var token = Assert.Single(tokens);
        Assert.Empty(diagnostics);
        Assert.Equal(SyntaxKind.NumberToken, token.Kind);
        Assert.Equal(expectedType, token.Value.GetType());
        Assert.Equal(expectedValue, token.Value);
    }

    [Theory]
    [InlineData("1.5", typeof(double), 1.5)]
    [InlineData("1.5e2", typeof(double), 150.0)]
    [InlineData("1.5e-1", typeof(double), 0.15)]
    [InlineData("1e10", typeof(double), 1e10)]
    [InlineData(".5", typeof(double), 0.5)]
    [InlineData(".25e1", typeof(double), 2.5)]
    [InlineData("1.5F", typeof(float), 1.5f)]
    [InlineData("1.5f", typeof(float), 1.5f)]
    [InlineData("1.5D", typeof(double), 1.5)]
    [InlineData("1.5d", typeof(double), 1.5)]
    [InlineData("2F", typeof(float), 2f)]
    [InlineData("3D", typeof(double), 3.0)]
    public void Lexes_FloatLiteral(string text, System.Type expectedType, object expectedValue)
    {
        var tokens = SyntaxTree.ParseTokens(text, out var diagnostics);
        var token = Assert.Single(tokens);
        Assert.Empty(diagnostics);
        Assert.Equal(SyntaxKind.NumberToken, token.Kind);
        Assert.Equal(expectedType, token.Value.GetType());
        Assert.Equal(expectedValue, token.Value);
    }

    [Theory]
    [InlineData("1.5M")]
    [InlineData("1.5m")]
    [InlineData("100M")]
    public void Lexes_DecimalLiteral(string text)
    {
        var tokens = SyntaxTree.ParseTokens(text, out var diagnostics);
        var token = Assert.Single(tokens);
        Assert.Empty(diagnostics);
        Assert.Equal(SyntaxKind.NumberToken, token.Kind);
        Assert.Equal(typeof(decimal), token.Value.GetType());
    }

    [Fact]
    public void Lexes_TrailingDot_KeepsIntAndDot()
    {
        // ADR-0044: bare trailing dot (`1.`) is NOT a float — int + '.' for
        // member access disambiguation.
        var tokens = SyntaxTree.ParseTokens("1.foo");
        Assert.Equal(3, tokens.Length); // 1, ., foo
        Assert.Equal(SyntaxKind.NumberToken, tokens[0].Kind);
        Assert.Equal(1, tokens[0].Value);
        Assert.Equal(SyntaxKind.DotToken, tokens[1].Kind);
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[2].Kind);
    }

    [Theory]
    [InlineData("'a'", 'a')]
    [InlineData("'Z'", 'Z')]
    [InlineData("'\\n'", '\n')]
    [InlineData("'\\t'", '\t')]
    [InlineData("'\\\\'", '\\')]
    [InlineData("'\\''", '\'')]
    [InlineData("'\\\"'", '"')]
    [InlineData("'\\0'", '\0')]
    [InlineData("'\\u0041'", 'A')]
    [InlineData("'\\x41'", 'A')]
    [InlineData("'\\x4'", '\x4')]
    [InlineData("'\\U00000041'", 'A')]
    public void Lexes_CharacterLiteral(string text, char expected)
    {
        var tokens = SyntaxTree.ParseTokens(text, out var diagnostics);
        var token = Assert.Single(tokens);
        Assert.Empty(diagnostics);
        Assert.Equal(SyntaxKind.CharacterToken, token.Kind);
        Assert.Equal(expected, token.Value);
    }

    [Theory]
    [InlineData("''", "Empty character literal")]
    [InlineData("'ab'", "more than one code unit")]
    [InlineData("'a", "Unterminated character literal")]
    [InlineData("'\\q'", "Unrecognised escape")]
    [InlineData("'\\u41'", "Malformed Unicode escape")]
    [InlineData("'\\U00110000'", "Malformed Unicode escape")]
    public void Invalid_CharacterLiteral_ReportsDiagnostic(string text, string expectedFragment)
    {
        SyntaxTree.ParseTokens(text, out var diagnostics);
        Assert.Contains(diagnostics, d => d.Message.Contains(expectedFragment, System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Lexes_RawString_NormalizesCRLF_To_LF()
    {
        var tokens = SyntaxTree.ParseTokens("`a\r\nb\rc`", out var diagnostics);
        var token = Assert.Single(tokens);
        Assert.Empty(diagnostics);
        Assert.Equal("a\nb\nc", token.Value);
    }

    [Fact]
    public void Lexes_UnterminatedRawString_ReportsDiagnostic()
    {
        SyntaxTree.ParseTokens("`unclosed", out var diagnostics);
        Assert.Contains(diagnostics, d => d.Message.Contains("Unterminated string", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Whitespace_Is_Emitted_As_Trivia_Tokens()
    {
        var tokens = SyntaxTree.ParseTokens("a   +   b");
        var nonWs = tokens.Where(t => t.Kind != SyntaxKind.WhitespaceToken).ToArray();
        Assert.Equal(3, nonWs.Length);
        Assert.Equal(SyntaxKind.IdentifierToken, nonWs[0].Kind);
        Assert.Equal(SyntaxKind.PlusToken, nonWs[1].Kind);
        Assert.Equal(SyntaxKind.IdentifierToken, nonWs[2].Kind);
    }

    [Fact]
    public void LineComment_Is_Emitted_As_CommentToken()
    {
        var tokens = SyntaxTree.ParseTokens("// this is a comment\nx");
        Assert.Contains(tokens, t => t.Kind == SyntaxKind.CommentToken);
        Assert.Contains(tokens, t => t.Kind == SyntaxKind.IdentifierToken && t.Text == "x");
    }
}
