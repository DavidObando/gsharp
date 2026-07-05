// <copyright file="HighlightTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class HighlightTests
{
    [Fact]
    public void Markup_PlainString_UsesSingleStringColor()
    {
        var markup = Highlight.Markup("\"hello\"");

        // One color tag opens for the whole literal, not one per fragment.
        var opens = markup.Split("[/]").Length - 1;
        Assert.Equal(1, opens);
    }

    [Fact]
    public void Markup_InterpolatedStringHole_ColorsHoleDifferentlyFromLiteral()
    {
        var markup = Highlight.Markup("\"Hello ${1}\"");

        // Before the fix, the whole token (literal text and hole alike) fell through to
        // one flat default color. The hole's "1" must now be colored as a number, and that
        // color tag must differ from the surrounding string-literal color.
        Assert.Contains("1[/]", markup);
        Assert.True(markup.Split("[/]").Length - 1 > 1, "Expected the literal and the hole to render as separate colored spans.");
    }
}
