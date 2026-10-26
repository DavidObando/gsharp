package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import System
import System.Collections.Immutable
import System.Linq
import Xunit

class Utf8StringFormattingTests {
    @Fact
    func FormattingPreservesLiteralKindsBytesSpellingCommentsAndFollowingLine() {
        const source = `func use(){
let value=(u8"\xFF$literal${unclosed" + u8"\uD83D\uDE00") // keep
let following=1
}`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let formatted = result.Text!!.ToString()
        let tokens = SyntaxTree
            .ParseTokens(formatted)
            .Where((token SyntaxToken) -> token.Kind == SyntaxKind.Utf8StringToken)
            .ToArray()
        Assert.Equal(2, tokens.Length)
        Assert.Equal(
            "C3BF246C69746572616C247B756E636C6F736564",
            Convert.ToHexString(cast[ImmutableArray[uint8]](tokens[0].Value!!).AsSpan())
        )
        Assert.Equal("F09F9880", Convert.ToHexString(cast[ImmutableArray[uint8]](tokens[1].Value!!).AsSpan()))
        Assert.Contains("// keep\n", formatted, StringComparison.Ordinal)
        Assert.Contains("let following = 1", formatted, StringComparison.Ordinal)
        Assert.Equal(formatted, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }
}
