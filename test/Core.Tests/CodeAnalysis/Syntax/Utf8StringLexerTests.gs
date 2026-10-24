package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import System.Text
import Xunit

class Utf8StringLexerTests {
    @Theory
    @InlineData(`u8"\uD800"`, 3, 6)
    @InlineData(`u8"\uDC00"`, 3, 6)
    @InlineData(`u8"\U00110000"`, 3, 10)
    @InlineData(`u8"\U0000D800"`, 3, 10)
    @InlineData(`u8"\u123"`, 3, 5)
    @InlineData(`u8"\x"`, 3, 2)
    @InlineData(`u8"\q"`, 3, 2)
    func InvalidScalarsAndEscapesHaveExactSpans(source string, start int32, length int32) {
        SyntaxTree.ParseTokens(source, out var diagnostics)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0632", diagnostic.Id)
        Assert.Equal(start, diagnostic.Location.Span.Start)
        Assert.Equal(length, diagnostic.Location.Span.Length)
    }

    @Fact
    func CompleteDecodedUtf16AndVariableWidthTextEscapesAreEncodedStrictly() {
        let token = Assert.Single(SyntaxTree.ParseTokens(`u8"\xD83D\uDE00\xF\xFF\xFFF\xFFFF0"`, out var diagnostics))
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.Utf8StringToken, token.Kind)
        Assert.Equal(
            "F09F98800FC3BFE0BFBFEFBFBF30",
            Convert.ToHexString(cast[ImmutableArray[uint8]](token.Value!!).AsSpan())
        )
        let unpaired = "u8\"" + char(0xD800) + "\""
        SyntaxTree.ParseTokens(unpaired, out var rejected)
        let diagnostic = Assert.Single(rejected)
        Assert.Equal("GS0632", diagnostic.Id)
        Assert.Equal(3, diagnostic.Location.Span.Start)
        Assert.Equal(1, diagnostic.Location.Span.Length)
    }

    @Fact
    func PrefixesStayContextualAndDollarsNeverOpenInterpolation() {
        let tokens = SyntaxTree
            .ParseTokens(`u8"$name ${unclosed" au8"x" $u8 "y" U8"z" u8 "w"`, out var diagnostics)
            .Where((token SyntaxToken) -> token.Kind != SyntaxKind.WhitespaceToken)
            .ToArray()
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.Utf8StringToken, tokens[0].Kind)
        Assert.Equal(
            "246E616D6520247B756E636C6F736564",
            Convert.ToHexString(cast[ImmutableArray[uint8]](tokens[0].Value!!).AsSpan())
        )
        for index in[]int32{1, 3, 5, 7} {
            Assert.Equal(SyntaxKind.IdentifierToken, tokens[index].Kind)
            Assert.Equal(SyntaxKind.StringToken, tokens[index + 1].Kind)
        }
    }

    @Fact
    func InterpolationHolesKeepNonInterpolatingUtf8AndWholeDocumentEncodingProvenance() {
        const text = `let a = "${u8"${unclosed".Length}${u8"b".Length}"`
        let tree = SyntaxTree.Parse(SourceText.From(text, rawBytes: Encoding.UTF8.GetBytes(text)))
        Assert.Empty(tree.Diagnostics)
        let rejected = SyntaxTree.Parse(SourceText.From(text, rawBytes: []uint8{0xFF}))
        Assert.Equal(2, rejected.Diagnostics.Length)
        for diagnostic in rejected.Diagnostics {
            Assert.Equal("GS0632", diagnostic.Id)
            Assert.Equal(3, diagnostic.Location.Span.Length)
        }
        Assert.Equal(text.IndexOf("u8\"", StringComparison.Ordinal), rejected.Diagnostics[0].Location.Span.Start)
        Assert.Equal(text.LastIndexOf("u8\"", StringComparison.Ordinal), rejected.Diagnostics[1].Location.Span.Start)
    }
}
