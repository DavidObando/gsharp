// <copyright file="HighlightTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import Xunit

open class HighlightTests {
    @Fact
    func Markup_Utf8String_UsesOneStringColorWithoutInterpolation() {
        let markup = Highlight.Markup(`u8"$name ${unclosed"`)
        Assert.Contains("u8\"", markup)
        Assert.Equal(1, markup.Split("[/]").Length - 1)
    }

    @Fact
    func Markup_PlainString_UsesSingleStringColor() {
        let markup = Highlight.Markup("\"hello\"")
        // One color tag opens for the whole literal, not one per fragment.
        let opens = markup.Split("[/]").Length - 1
        Assert.Equal(1, opens)
    }

    @Fact
    func Markup_InterpolatedStringHole_ColorsHoleDifferentlyFromLiteral() {
        let markup = Highlight.Markup("\"Hello $${1}\"")
        // Before the fix, the whole token (literal text and hole alike) fell through to
        // one flat default color. The hole's "1" must now be colored as a number, and that
        // color tag must differ from the surrounding string-literal color.
        Assert.Contains("1[/]", markup)
        Assert.True(
            markup.Split("[/]").Length - 1 > 1,
            "Expected the literal and the hole to render as separate colored spans."
        )
    }
}
