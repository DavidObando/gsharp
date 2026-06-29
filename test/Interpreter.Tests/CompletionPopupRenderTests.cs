// <copyright file="CompletionPopupRenderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Repl;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Tests for the windowed/scrolling completion popup, including the index counter.
/// </summary>
public class CompletionPopupRenderTests
{
    private static IReadOnlyList<CompletionEntry> Items(int n) =>
        Enumerable.Range(0, n).Select(i => new CompletionEntry("sym" + i, "detail", "var")).ToList();

    [Fact]
    public void RenderLines_ShowsIndexCounter()
    {
        var popup = new CompletionPopup(Items(12), windowSize: 8);
        var lines = popup.RenderLines();
        Assert.Contains(lines, l => l.Contains("1/12"));
    }

    [Fact]
    public void RenderLines_WindowsLargeListToWindowSizePlusCounter()
    {
        var popup = new CompletionPopup(Items(50), windowSize: 8);
        var lines = popup.RenderLines();
        Assert.Equal(9, lines.Count);
    }

    [Fact]
    public void RenderLines_HighlightsSelection()
    {
        var popup = new CompletionPopup(Items(3));
        var lines = popup.RenderLines();
        Assert.Contains(lines, l => l.Contains("invert"));
    }

    [Fact]
    public void Next_WrapsAroundAndUpdatesCounter()
    {
        var popup = new CompletionPopup(Items(3));
        popup.Next();
        popup.Next();
        popup.Next();
        Assert.Equal(0, popup.Selected);
        Assert.Contains(popup.RenderLines(), l => l.Contains("1/3"));
    }

    [Fact]
    public void RenderLines_EmptyList_ShowsNoCompletions()
    {
        var popup = new CompletionPopup(Items(0));
        var lines = popup.RenderLines();
        Assert.Contains(lines, l => l.Contains("no completions"));
    }
}
