// <copyright file="SourceTextGetLineIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Text

import GSharp.Core.CodeAnalysis.Text
import Xunit

open class SourceTextGetLineIndexTests {
    @Fact
    func GetLineIndex_AtStart_ReturnsZero() {
        let text = SourceText.From("abc\r\ndef\r\nghi")
        Assert.Equal(0, text.GetLineIndex(0))
    }

    @Fact
    func GetLineIndex_AtStartOfSecondLine_ReturnsOne() {
        let text = SourceText.From("abc\r\ndef")
        let secondLineStart = text.Lines[1].Start
        Assert.Equal(1, text.GetLineIndex(secondLineStart))
    }

    @Fact
    func GetLineIndex_InMiddleOfLine_ReturnsThatLine() {
        let text = SourceText.From("abc\r\ndef\r\nghi")
        Assert.Equal(1, text.GetLineIndex(text.Lines[1].Start + 1))
    }

    @Fact
    func ToString_Span_ReturnsSubstring() {
        let text = SourceText.From("abcdef")
        Assert.Equal("cd", text.ToString(TextSpan(2, 2)))
    }
}
