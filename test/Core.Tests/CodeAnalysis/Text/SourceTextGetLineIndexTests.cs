// <copyright file="SourceTextGetLineIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Text;

public class SourceTextGetLineIndexTests
{
    [Fact]
    public void GetLineIndex_AtStart_ReturnsZero()
    {
        var text = SourceText.From("abc\r\ndef\r\nghi");
        Assert.Equal(0, text.GetLineIndex(0));
    }

    [Fact]
    public void GetLineIndex_AtStartOfSecondLine_ReturnsOne()
    {
        var text = SourceText.From("abc\r\ndef");
        var secondLineStart = text.Lines[1].Start;
        Assert.Equal(1, text.GetLineIndex(secondLineStart));
    }

    [Fact]
    public void GetLineIndex_InMiddleOfLine_ReturnsThatLine()
    {
        var text = SourceText.From("abc\r\ndef\r\nghi");
        Assert.Equal(1, text.GetLineIndex(text.Lines[1].Start + 1));
    }

    [Fact]
    public void ToString_Span_ReturnsSubstring()
    {
        var text = SourceText.From("abcdef");
        Assert.Equal("cd", text.ToString(new TextSpan(2, 2)));
    }
}
