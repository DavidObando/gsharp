// <copyright file="ByteStringFormattingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import System.Collections.Immutable
import System.Linq
import Xunit

class ByteStringFormattingTests {
    @Fact
    func FormattingPreservesExactBytesAndOrdinaryNameEscapes() {
        const source = `func parse(value bytestring) bytestring{
let delimiter=b"\xFF$literal${notInterpolation}\u00E9"
let $bytestring=b"\0"
return value[1..]+delimiter+$bytestring
}`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let formatted = result.Text!!.ToString()
        Assert.Contains("b\"\\xFF$$literal$${notInterpolation}\\u00E9\"", formatted)
        Assert.Contains("$$bytestring", formatted)
        let before = SyntaxTree
            .ParseTokens(source)
            .Where((token SyntaxToken) -> token.Kind == SyntaxKind.ByteStringToken)
            .SelectMany((token SyntaxToken) -> cast[ImmutableArray[uint8]](token.Value!!))
            .ToArray()
        let after = SyntaxTree
            .ParseTokens(formatted)
            .Where((token SyntaxToken) -> token.Kind == SyntaxKind.ByteStringToken)
            .SelectMany((token SyntaxToken) -> cast[ImmutableArray[uint8]](token.Value!!))
            .ToArray()
        Assert.NotEmpty(before)
        Assert.Equal(before, after)
        Assert.Equal(formatted, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }
}
