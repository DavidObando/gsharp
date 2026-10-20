// <copyright file="ByteStringLexerTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import Xunit

class ByteStringLexerTests {
    @Theory
    @InlineData("b\"\\xFF\\x80\\0\\n\\r\\t\\\\\\\"$$x$${y}\"", "FF80000A0D095C222478247B797D")
    @InlineData("b\"\\u00E9\\U0001F600\\u0000\"", "C3A9F09F988000")
    @InlineData("b\"\\x000\"", "0030")
    func ExactBytesAreNotTextDecoded(source string, expected string) {
        let tokens = SyntaxTree.ParseTokens(source, out var diagnostics)
        Assert.Empty(diagnostics)
        let token = Assert.Single(tokens)
        Assert.Equal(SyntaxKind.ByteStringToken, token.Kind)
        Assert.Equal(expected, Convert.ToHexString(cast[ImmutableArray[uint8]](token.Value!!).AsSpan()))
    }

    @Fact
    func RawScalarsEncodeWithoutNormalizationAndPrefixesStayLexical() {
        let text = "b\"" + char.ConvertFromUtf32(0x1F600) + "\u0065\u0301\""
        let token = Assert.Single(SyntaxTree.ParseTokens(text, out var diagnostics))
        Assert.Empty(diagnostics)
        Assert.Equal("F09F988065CC81", Convert.ToHexString(cast[ImmutableArray[uint8]](token.Value!!).AsSpan()))
        let ordinary = SyntaxTree.ParseTokens("ab\"x\" $$b \"y\"")
        Assert.Equal(SyntaxKind.IdentifierToken, ordinary[0].Kind)
        Assert.Equal(SyntaxKind.StringToken, ordinary[1].Kind)
    }

    @Theory
    @InlineData("b\"\\xF\"", int32(2), int32(3))
    @InlineData("b\"\\xGG\"", int32(2), int32(2))
    @InlineData("b\"\\uD800\"", int32(2), int32(6))
    @InlineData("b\"\\uDC00\"", int32(2), int32(6))
    @InlineData("b\"\\U00110000\"", int32(2), int32(10))
    @InlineData("b\"\\UFFFFFFFF\"", int32(2), int32(10))
    @InlineData("b\"\\a\"", int32(2), int32(2))
    func MalformedEscapesHaveExactSourceSpans(source string, start int32, length int32) {
        SyntaxTree.ParseTokens(source, out var diagnostics)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0628", diagnostic.Id)
        Assert.Equal(start, diagnostic.Location.Span.Start)
        Assert.Equal(length, diagnostic.Location.Span.Length)
    }

    @Theory
    @InlineData("b\"")
    @InlineData("b\"\\")
    @InlineData("b\"\\\nlet next = 1")
    func UnterminatedLiteralsStayWithinSourceBounds(source string) {
        SyntaxTree.ParseTokens(source, out var diagnostics)
        Assert.Contains(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0003")
        Assert.NotEmpty(diagnostics)
        Assert.All(
            diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> {
                Assert.InRange(diagnostic.Location.Span.End, 0, source.Length)
            }
        )
    }

    @Fact
    func LossyFileDecodingCannotSilentlyChangeLiteralBytes() {
        const text = "b\"\uFFFD\""
        for raw in[][]uint8{[]uint8{0x62, 0x22, 0xFF, 0x22}, []uint8{0xFF, 0xFE, 0x62, 0, 0x22, 0, 0, 0xD8, 0x22, 0}} {
            SyntaxTree.ParseTokens(SourceText.From(text, rawBytes: raw), out var diagnostics)
            let diagnostic = Assert.Single(diagnostics)
            Assert.Equal("GS0628", diagnostic.Id)
            Assert.Equal(0, diagnostic.Location.Span.Start)
            Assert.Equal(2, diagnostic.Location.Span.Length)
        }
        let valid = Assert.Single(SyntaxTree.ParseTokens(text, out var validDiagnostics))
        Assert.Empty(validDiagnostics)
        Assert.Equal("EFBFBD", Convert.ToHexString(cast[ImmutableArray[uint8]](valid.Value!!).AsSpan()))
    }
}
