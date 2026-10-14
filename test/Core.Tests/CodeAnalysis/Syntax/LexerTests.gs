// <copyright file="LexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit
import GSharp.Core.CodeAnalysis
import System
import System.Collections.Generic
import System.Text

open class LexerTests {
    @Theory
    @InlineData("+", SyntaxKind(5))
    @InlineData("+=", SyntaxKind(6))
    @InlineData("++", SyntaxKind(7))
    @InlineData("-", SyntaxKind(8))
    @InlineData("*", SyntaxKind(11))
    @InlineData("/", SyntaxKind(13))
    @InlineData("==", SyntaxKind(42))
    @InlineData("!=", SyntaxKind(44))
    @InlineData("<=", SyntaxKind(52))
    @InlineData(">=", SyntaxKind(58))
    @InlineData("&&", SyntaxKind(34))
    @InlineData("||", SyntaxKind(40))
    @InlineData(":=", SyntaxKind(24))
    @InlineData("...", SyntaxKind(29))
    @InlineData("..", SyntaxKind(28))
    @InlineData("<-", SyntaxKind(53))
    func Lexes_Operator(text string, expected SyntaxKind) {
        let tokens = SyntaxTree.ParseTokens(text)
        let token = Assert.Single(tokens)
        Assert.Equal(expected, token.Kind)
        Assert.Equal(text, token.Text)
    }

    @Theory
    @InlineData("func", SyntaxKind(87))
    @InlineData("if", SyntaxKind(90))
    @InlineData("else", SyntaxKind(81))
    @InlineData("for", SyntaxKind(86))
    @InlineData("return", SyntaxKind(106))
    @InlineData("package", SyntaxKind(101))
    @InlineData("import", SyntaxKind(91))
    @InlineData("true", SyntaxKind(116))
    @InlineData("false", SyntaxKind(84))
    func Lexes_Keyword(text string, expected SyntaxKind) {
        let tokens = SyntaxTree.ParseTokens(text)
        let token = Assert.Single(tokens)
        Assert.Equal(expected, token.Kind)
    }

    @Theory
    @InlineData("identifier")
    @InlineData("camelCase")
    @InlineData("num1")
    @InlineData("a1b2c3")
    @InlineData("_x")
    @InlineData("x_y")
    @InlineData("var123")
    @InlineData("_")
    func Lexes_Identifier(text string) {
        let tokens = SyntaxTree.ParseTokens(text)
        let token = Assert.Single(tokens)
        Assert.Equal(SyntaxKind.IdentifierToken, token.Kind)
        Assert.Equal(text, token.Text)
    }

    @Fact
    func Identifier_Cannot_Start_With_Digit() {
        let tokens = SyntaxTree.ParseTokens("1abc")
        Assert.Collection(
            tokens,
            (t SyntaxToken) -> {
                Assert.Equal(SyntaxKind.NumberToken, t.Kind)
                Assert.Equal("1", t.Text)
            },
            (t SyntaxToken) -> {
                Assert.Equal(SyntaxKind.IdentifierToken, t.Kind)
                Assert.Equal("abc", t.Text)
            }
        )
    }

    @Theory
    @InlineData("42")
    @InlineData("0")
    @InlineData("12345")
    func Lexes_NumberLiteral(text string) {
        let tokens = SyntaxTree.ParseTokens(text)
        let token = Assert.Single(tokens)
        Assert.Equal(SyntaxKind.NumberToken, token.Kind)
        Assert.Equal(int32.Parse(text), token.Value)
    }

    @Theory
    @InlineData("0x1F", int32(31))
    @InlineData("0X_FF", int32(255))
    @InlineData("0xDEAD_BEEF", int32(-559038737))
    @InlineData("0o17", int32(15))
    @InlineData("0O_77", int32(63))
    @InlineData("0b1010", int32(10))
    @InlineData("0B_1010_1010", int32(170))
    @InlineData("1_000_000", int32(1000000))
    @InlineData("1_2_3", int32(123))
    func Lexes_NumberLiteral_Variants(text string, expected int32) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.NumberToken, token.Kind)
        Assert.Equal(expected, token.Value)
        Assert.Equal(text, token.Text)
    }

    @Theory
    @InlineData("_1")
    @InlineData("1_")
    @InlineData("0x_")
    @InlineData("0b")
    func Invalid_NumberLiteral_Reports_Diagnostic(text string) {
        SyntaxTree.ParseTokens(text, out var diagnostics)
        if text == "_1" {
            // Not actually a number — verify it isn't silently consumed as one.
            Assert.DoesNotContain(
                diagnostics,
                (d Diagnostic) -> d.Message.Contains("number", StringComparison.OrdinalIgnoreCase)
            )
        } else {
            Assert.Contains(
                diagnostics,
                (d Diagnostic) -> d.Message.Contains("number", StringComparison.OrdinalIgnoreCase)
            )
        }
    }

    @Fact
    func Lexes_StringLiteral() {
        let tokens = SyntaxTree.ParseTokens("\"hello\"")
        let token = Assert.Single(tokens)
        Assert.Equal(SyntaxKind.StringToken, token.Kind)
        Assert.Equal("hello", token.Value)
    }

    @Fact
    func Lexes_UnterminatedString_ReportsDiagnostic() {
        SyntaxTree.ParseTokens("\"hello", out var diagnostics)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("Unterminated string", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func Lexes_BadCharacter_ReportsDiagnostic() {
        // Backtick alone (without a closing backtick) is now an unterminated
        // raw string per Phase 1.2, not a bad character. Use a character that
        // remains unmapped to exercise the bad-character diagnostic.
        SyntaxTree.ParseTokens("#", out var diagnostics)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("Bad character", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Theory
    @InlineData("`hello`", "hello")
    @InlineData("``", "")
    @InlineData("`line1\nline2`", "line1\nline2")
    @InlineData("`no \\n escapes here`", "no \\n escapes here")
    @InlineData("`\"quoted\"`", "\"quoted\"")
    func Lexes_RawStringLiteral(text string, expectedValue string) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.StringToken, token.Kind)
        Assert.Equal(expectedValue, token.Value)
    }

    @Theory
    @InlineData("1L", typeof(int64), int64(1))
    @InlineData("1l", typeof(int64), int64(1))
    @InlineData("1U", typeof(uint32), uint32(1))
    @InlineData("1u", typeof(uint32), uint32(1))
    @InlineData("1UL", typeof(uint64), uint64(1))
    @InlineData("1ul", typeof(uint64), uint64(1))
    @InlineData("1LU", typeof(uint64), uint64(1))
    @InlineData("1lu", typeof(uint64), uint64(1))
    @InlineData("0xFFL", typeof(int64), int64(255))
    @InlineData("0xFFU", typeof(uint32), uint32(255))
    @InlineData("0xFFUL", typeof(uint64), uint64(255))
    func Lexes_IntegerLiteral_WithSuffix(text string, expectedType Type, expectedValue object) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.NumberToken, token.Kind)
        Assert.Equal(expectedType, token.Value!!.GetType())
        Assert.Equal(expectedValue, token.Value)
    }

    // C# §6.4.5.3: an un-suffixed integer literal infers the first of int32,
    // uint32, int64, uint64 in which its value fits. Values that already fit
    // int32 stay int32 (no regression); larger ones widen.
    @Theory
    @InlineData("42", typeof(int32), int32(42))
    @InlineData("2147483647", typeof(int32), int32(2147483647))
    @InlineData("2147483648", typeof(uint32), uint32(2147483648))
    @InlineData("4294967295", typeof(uint32), uint32(4294967295))
    @InlineData("4294967296", typeof(int64), int64(4294967296))
    @InlineData("9223372036854775807", typeof(int64), int64(9223372036854775807))
    @InlineData("9223372036854775808", typeof(uint64), uint64(9223372036854775808))
    @InlineData("18446744073709551615", typeof(uint64), uint64(18446744073709551615))
    @InlineData("0x1_0000_0000", typeof(int64), int64(4294967296))
    func Lexes_UnsuffixedIntegerLiteral_InfersWideningType(text string, expectedType Type, expectedValue object) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.NumberToken, token.Kind)
        Assert.Equal(expectedType, token.Value!!.GetType())
        Assert.Equal(expectedValue, token.Value)
    }

    // A bare literal exceeding uint64 (the widest §6.4.5.3 candidate) still
    // reports GS0004 rather than silently wrapping.
    @Theory
    @InlineData("18446744073709551616")
    @InlineData("99999999999999999999999999")
    func Lexes_UnsuffixedIntegerLiteral_ExceedingUInt64_Reports(text string) {
        let _ = SyntaxTree.ParseTokens(text, out var diagnostics)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0004")
    }

    @Theory
    @InlineData("1.5", typeof(float64), 1.5)
    @InlineData("1.5e2", typeof(float64), 150.0)
    @InlineData("1.5e-1", typeof(float64), 0.15)
    @InlineData("1e10", typeof(float64), 1e10)
    @InlineData(".5", typeof(float64), 0.5)
    @InlineData(".25e1", typeof(float64), 2.5)
    @InlineData("1.5F", typeof(float32), 1.5f)
    @InlineData("1.5f", typeof(float32), 1.5f)
    @InlineData("1.5D", typeof(float64), 1.5)
    @InlineData("1.5d", typeof(float64), 1.5)
    @InlineData("2F", typeof(float32), 2f)
    @InlineData("3D", typeof(float64), 3.0)
    func Lexes_FloatLiteral(text string, expectedType Type, expectedValue object) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.NumberToken, token.Kind)
        Assert.Equal(expectedType, token.Value!!.GetType())
        Assert.Equal(expectedValue, token.Value)
    }

    // .NET Core 3.0+ float/double.Parse returns ±Infinity for out-of-range
    // text instead of throwing. G# has no infinity literal syntax, so any
    // non-finite parse result is a genuine overflow (issue #1606) and must
    // report GS0004 rather than silently producing Infinity.
    @Theory
    @InlineData("1e999")
    @InlineData("1e999d")
    @InlineData("1e40f")
    func Lexes_FloatLiteral_Overflow_Reports(text string) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0004")
        Assert.False(float64.IsInfinity(Convert.ToDouble(token.Value)))
    }

    @Theory
    @InlineData("1.5M")
    @InlineData("1.5m")
    @InlineData("100M")
    func Lexes_DecimalLiteral(text string) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.NumberToken, token.Kind)
        Assert.Equal(typeof(decimal), token.Value!!.GetType())
    }

    @Fact
    func Lexes_TrailingDot_KeepsIntAndDot() {
        // ADR-0044: bare trailing dot (`1.`) is NOT a float — int + '.' for
        // member access disambiguation.
        let tokens = SyntaxTree.ParseTokens("1.foo")
        Assert.Equal(3, tokens.Length) // 1, ., foo
        Assert.Equal(SyntaxKind.NumberToken, tokens[0].Kind)
        Assert.Equal(1, tokens[0].Value)
        Assert.Equal(SyntaxKind.DotToken, tokens[1].Kind)
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[2].Kind)
    }

    @Theory
    @InlineData("'a'", 'a')
    @InlineData("'Z'", 'Z')
    @InlineData("'\\n'", '\n')
    @InlineData("'\\t'", '\t')
    @InlineData("'\\\\'", '\\')
    @InlineData("'\\''", '\'')
    @InlineData("'\\\"'", '"')
    @InlineData("'\\0'", '\u0000')
    @InlineData("'\\u0041'", 'A')
    @InlineData("'\\x41'", 'A')
    @InlineData("'\\x4'", '\u0004')
    @InlineData("'\\U00000041'", 'A')
    func Lexes_CharacterLiteral(text string, expected char) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.CharacterToken, token.Kind)
        Assert.Equal(expected, token.Value)
    }

    @Theory
    @InlineData("''", "Empty character literal")
    @InlineData("'ab'", "more than one code unit")
    @InlineData("'a", "Unterminated character literal")
    @InlineData("'\\q'", "Unrecognised escape")
    @InlineData("'\\u41'", "Malformed Unicode escape")
    @InlineData("'\\U00110000'", "Malformed Unicode escape")
    func Invalid_CharacterLiteral_ReportsDiagnostic(text string, expectedFragment string) {
        SyntaxTree.ParseTokens(text, out var diagnostics)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains(expectedFragment, StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func Lexes_RawString_NormalizesCRLF_To_LF() {
        let tokens = SyntaxTree.ParseTokens("`a\r\nb\rc`", out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}c", token.Value)
    }

    @Fact
    func Lexes_UnterminatedRawString_ReportsDiagnostic() {
        SyntaxTree.ParseTokens("`unclosed", out var diagnostics)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("Unterminated string", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func Whitespace_Is_Emitted_As_Trivia_Tokens() {
        let tokens = SyntaxTree.ParseTokens("a   +   b")
        let nonWs = tokens.Where((t SyntaxToken) -> t.Kind != SyntaxKind.WhitespaceToken).ToArray()
        Assert.Equal(3, nonWs.Length)
        Assert.Equal(SyntaxKind.IdentifierToken, nonWs[0].Kind)
        Assert.Equal(SyntaxKind.PlusToken, nonWs[1].Kind)
        Assert.Equal(SyntaxKind.IdentifierToken, nonWs[2].Kind)
    }

    @Fact
    func LineComment_Is_Emitted_As_CommentToken() {
        let tokens = SyntaxTree.ParseTokens("// this is a comment\nx")
        Assert.Contains(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.CommentToken)
        Assert.Contains(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken && t.Text == "x")
    }

    @Theory
    @InlineData("\"a\\nb\"", "a\nb")
    @InlineData("\"a\\rb\"", "a\rb")
    @InlineData("\"a\\tb\"", "a\tb")
    @InlineData("\"a\\\\b\"", "a\\b")
    @InlineData("\"a\\\"b\"", "a\"b")
    @InlineData("\"a\\'b\"", "a'b")
    @InlineData("\"a\\0b\"", "a\u0000b")
    @InlineData("\"a\\ab\"", "a\u0007b")
    @InlineData("\"a\\bb\"", "a\u0008b")
    @InlineData("\"a\\fb\"", "a\u000Cb")
    @InlineData("\"a\\vb\"", "a\u000Bb")
    @InlineData("\"\\x41\"", "A")
    @InlineData("\"\\x041\"", "A")
    @InlineData("\"\\x0041\"", "A")
    @InlineData("\"\\x4\"", "\u0004")
    @InlineData("\"\\u0041\"", "A")
    @InlineData("\"\\u00e9\"", "é")
    @InlineData("\"\\U00000041\"", "A")
    func Lexes_StringEscapeSequence(text string, expectedValue string) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.StringToken, token.Kind)
        Assert.Equal(expectedValue, token.Value)
    }

    @Fact
    func String_Escape_Newline_HasCorrectLength() {
        // Issue #531: "a\nb".Length == 3, not 4.
        let tokens = SyntaxTree.ParseTokens("\"a\\nb\"", out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(3, (cast[string](token.Value)).Length)
    }

    @Theory
    @InlineData("\"\\q\"", "Unrecognised escape")
    @InlineData("\"\\z\"", "Unrecognised escape")
    @InlineData("\"\\u41\"", "Malformed Unicode escape")
    @InlineData("\"\\U00110000\"", "Malformed Unicode escape")
    func Invalid_StringEscape_ReportsDiagnostic(text string, expectedFragment string) {
        SyntaxTree.ParseTokens(text, out var diagnostics)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains(expectedFragment, StringComparison.OrdinalIgnoreCase)
        )
    }

    @Theory
    @InlineData("`no \\n escapes here`", "no \\n escapes here")
    @InlineData("`a\\tb`", "a\\tb")
    @InlineData("`\\\\`", "\\\\")
    func RawString_DoesNotProcessEscapes(text string, expectedValue string) {
        let tokens = SyntaxTree.ParseTokens(text, out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.StringToken, token.Kind)
        Assert.Equal(expectedValue, token.Value)
    }

    @Fact
    func InterpolatedString_ProcessesEscapesInLiteralSegments() {
        // "hello\\n$name" should have the literal segment "hello\n" with an actual newline.
        let tokens = SyntaxTree.ParseTokens("\"hello\\n$$name\"", out var diagnostics)
        let token = Assert.Single(tokens)
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.InterpolatedStringToken, token.Kind)
        let fragments = Assert.IsType[InterpolationFragments](token.Value).Items
        Assert.Equal(2, fragments.Length)
        Assert.False(fragments[0].IsExpression)
        Assert.Equal("hello${Environment.NewLine}", fragments[0].Text)
    }

    @Fact
    func EmbeddedNul_ReportsDiagnostic_AndDoesNotTruncateFile() {
        // Issue #1608: an embedded NUL used to be indistinguishable from EOF,
        // silently dropping everything after it.
        let tree = SyntaxTree.Parse("let a = 1\n\u0000let b = 2\n")
        Assert.Contains(
            tree.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Bad character", StringComparison.OrdinalIgnoreCase)
        )
        Assert.Equal(2, tree.Root.Members.Length)
    }

    @Fact
    func NormalInput_StillLexesToSingleTrailingEndOfFileToken() {
        let sourceText = SourceText.From("let a = 1")
        let syntaxTree = SyntaxTree.Parse(sourceText)
        let lexer = Lexer(syntaxTree)
        let tokens = List[SyntaxToken]()
        var token SyntaxToken
        do {
            token = lexer.Lex()
            tokens.Add(token)
        } while token.Kind != SyntaxKind.EndOfFileToken
        Assert.Empty(lexer.Diagnostics)
        Assert.Equal(SyntaxKind.EndOfFileToken, tokens[^1].Kind)
        Assert.Single(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.EndOfFileToken)
    }

    @Fact
    func RepeatedIdentifiers_ShareSameTextInstance() {
        // Issue #1677: repeated identifiers must be interned (same reference) but still
        // compare equal by value, and every occurrence must keep its own correct Span/Start.
        let tokens = SyntaxTree
            .ParseTokens("foo foo foo bar foo")
            .Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken)
            .ToImmutableArray()
        Assert.Equal(5, tokens.Length)
        let fooTokens = tokens.Where((t SyntaxToken) -> t.Text == "foo").ToImmutableArray()
        Assert.Equal(4, fooTokens.Length)
        Assert.Same(fooTokens[0].Text, fooTokens[1].Text)
        Assert.Same(fooTokens[0].Text, fooTokens[2].Text)
        Assert.Same(fooTokens[0].Text, fooTokens[3].Text)
        Assert.NotSame(fooTokens[0].Text, tokens.First((t SyntaxToken) -> t.Text == "bar").Text)
        // Spans still reflect each occurrence's own position despite sharing text.
        Assert.Equal(0, tokens[0].Span.Start)
        Assert.Equal(4, tokens[1].Span.Start)
        Assert.Equal(8, tokens[2].Span.Start)
        Assert.Equal(12, tokens[3].Span.Start)
        Assert.Equal(16, tokens[4].Span.Start)
    }

    @Theory
    @InlineData("a  b")
    @InlineData("a\tb")
    @InlineData("a\nb")
    @InlineData("a \t\t b")
    func Whitespace_TextAndSpan_AreExact(source string) {
        // Issue #1677: whitespace text may be served from a shared cache for uniform runs,
        // but must still be value-identical to (and long enough to reconstruct) the source.
        let tokens = SyntaxTree.ParseTokens(source)
        let reconstructed = StringBuilder()
        for token in tokens.Where((t SyntaxToken) -> t.Kind != SyntaxKind.EndOfFileToken) {
            Assert.Equal(token.Span.Length, token.Text.Length)
            reconstructed.Append(token.Text)
        }
        Assert.Equal(source, reconstructed.ToString())
    }

    @Fact
    func UniformWhitespaceRuns_OfSameLength_ShareTextInstance() {
        // Issue #1677: same-length, same-character whitespace runs (e.g. matching indentation)
        // are served from a shared cache instead of a fresh substring per occurrence.
        let tokens = SyntaxTree
            .ParseTokens("a   b   c")
            .Where((t SyntaxToken) -> t.Kind == SyntaxKind.WhitespaceToken)
            .ToImmutableArray()
        Assert.Equal(2, tokens.Length)
        Assert.Equal("   ", tokens[0].Text)
        Assert.Same(tokens[0].Text, tokens[1].Text)
    }

    @Fact
    func UniformWhitespaceRuns_AcrossLexers_ShareTextInstance() {
        let first = SyntaxTree.ParseTokens("a    b").Single((t SyntaxToken) -> t.Kind == SyntaxKind.WhitespaceToken)
        let second = SyntaxTree.ParseTokens("c    d").Single((t SyntaxToken) -> t.Kind == SyntaxKind.WhitespaceToken)
        Assert.Same(first.Text, second.Text)
    }
}
