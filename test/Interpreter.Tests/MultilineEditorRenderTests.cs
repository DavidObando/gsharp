// <copyright file="MultilineEditorRenderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Repl;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Tests for <see cref="MultilineEditor"/> editing and block-cursor rendering.
/// </summary>
public class MultilineEditorRenderTests
{
    [Fact]
    public void RenderLines_EmptyBuffer_ShowsBlockCursor()
    {
        var editor = new MultilineEditor();
        var lines = editor.RenderLines();
        Assert.Single(lines);
        Assert.Contains("[invert]", lines[0]);
    }

    [Fact]
    public void RenderLines_DrawsBlockCursorWithinTypedText()
    {
        var editor = new MultilineEditor();
        editor.InsertText("let x");
        editor.MoveLeft();
        var lines = editor.RenderLines();
        Assert.Contains("[invert]", lines[0]);
    }

    [Fact]
    public void RenderLines_WithoutCursor_HasNoInvert()
    {
        var editor = new MultilineEditor();
        editor.InsertText("let x = 42");
        var rendered = editor.RenderLines(showCursor: false);
        Assert.DoesNotContain("[invert]", rendered[0]);
    }

    [Fact]
    public void InsertText_NewLine_SplitsBuffer()
    {
        var editor = new MultilineEditor();
        editor.InsertText("a\nb");
        Assert.Equal(2, editor.LineCount);
        Assert.Equal("a\nb", editor.Text);
        Assert.Equal(1, editor.CursorLine);
        Assert.Equal(1, editor.CursorColumn);
    }

    [Fact]
    public void Backspace_AtLineStart_MergesLines()
    {
        var editor = new MultilineEditor();
        editor.InsertText("a\nb");
        editor.MoveHome();
        editor.Backspace();
        Assert.Equal(1, editor.LineCount);
        Assert.Equal("ab", editor.Text);
    }

    [Fact]
    public void RenderLines_HighlightsKeyword()
    {
        var editor = new MultilineEditor();
        editor.InsertText("let");
        var rendered = editor.RenderLines(showCursor: false);
        Assert.Contains("deepskyblue1", rendered[0]);
    }
}
