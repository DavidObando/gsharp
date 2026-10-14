// <copyright file="Issue4350IndexRangeFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import Xunit

/// ADR-0187 / issue #4350: the formatter keeps prefix `^x` (from-end
/// Index), prefix `~x` (one's-complement), binary `x ^ y` (XOR),
/// and leading from-end ranges intact and idempotent.
class Issue4350IndexRangeFormattingTests {
    @Fact
    func FromEndTildeAndXorSpellingsFormatStably() {
        const source = `let last=^1
let r=^4..^1
let tail=^n..
let inverted=~mask
let mixed=a^b
let slot=xs[~i]
func (a Bits) operator ~() Bits -> Bits{Value:~a.Value}`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let text = result.Text!!.ToString()
        Assert.Contains("let last = ^1", text)
        Assert.Contains("let r = ^4 .. ^1", text)
        Assert.Contains("let tail = ^n ..", text)
        Assert.Contains("let inverted = ~mask", text)
        Assert.Contains("let mixed = a ^ b", text)
        Assert.Contains("let slot = xs[~i]", text)
        Assert.Contains("operator ~ ()", text)
        Assert.Contains("Value: ~a.Value", text)
        Assert.Equal(text, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }
}
