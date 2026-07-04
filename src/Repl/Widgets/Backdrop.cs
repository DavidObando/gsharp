// <copyright file="Backdrop.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>
/// Wraps a child renderable in a solid background block that fills the full available
/// width, in the OpenCode/Copilot-CLI style. Optionally draws a themed one-cell accent
/// bar down the left edge (used by the input box and sidebar) and adds interior padding
/// rows. Emits line breaks <em>between</em> lines only (no trailing break) so callers can
/// compose deterministic fixed-height layouts.
/// </summary>
public sealed class Backdrop : Renderable
{
    private const string AccentGlyph = "▏";

    private readonly IRenderable child;
    private readonly Color background;
    private readonly Color? accent;
    private readonly int padLeft;
    private readonly int padRight;
    private readonly int padTop;
    private readonly int padBottom;
    private readonly int minHeight;

    public Backdrop(
        IRenderable child,
        Color background,
        Color? accent = null,
        int padLeft = 1,
        int padRight = 1,
        int padTop = 0,
        int padBottom = 0,
        int minHeight = 0)
    {
        this.child = child ?? throw new ArgumentNullException(nameof(child));
        this.background = background;
        this.accent = accent;
        this.padLeft = Math.Max(0, padLeft);
        this.padRight = Math.Max(0, padRight);
        this.padTop = Math.Max(0, padTop);
        this.padBottom = Math.Max(0, padBottom);
        this.minHeight = Math.Max(0, minHeight);
    }

    protected override Measurement Measure(RenderOptions options, int maxWidth)
        => new(maxWidth, maxWidth);

    protected override IEnumerable<Segment> Render(RenderOptions options, int maxWidth)
    {
        var bg = new Style(background: background);
        var barStyle = accent is { } a ? new Style(foreground: a, background: background) : bg;
        var barWidth = accent is null ? 0 : 1;

        var innerWidth = Math.Max(1, maxWidth - barWidth - padLeft - padRight);
        var lines = Segment.SplitLines(child.Render(options, innerWidth));

        var outLines = new List<List<Segment>>();

        for (var i = 0; i < padTop; i++)
        {
            outLines.Add(FrameLine(maxWidth, barWidth, barStyle, bg));
        }

        foreach (var line in lines)
        {
            var row = new List<Segment>();
            if (barWidth > 0)
            {
                row.Add(new Segment(AccentGlyph, barStyle, null));
            }

            if (padLeft > 0)
            {
                row.Add(new Segment(new string(' ', padLeft), bg, null));
            }

            var used = 0;
            foreach (var seg in line)
            {
                row.Add(new Segment(seg.Text, seg.Style.Combine(bg), null));
                used += seg.CellCount();
            }

            var fill = maxWidth - barWidth - padLeft - used;
            if (fill > 0)
            {
                row.Add(new Segment(new string(' ', fill), bg, null));
            }

            outLines.Add(row);
        }

        for (var i = 0; i < padBottom; i++)
        {
            outLines.Add(FrameLine(maxWidth, barWidth, barStyle, bg));
        }

        while (outLines.Count < minHeight)
        {
            outLines.Add(FrameLine(maxWidth, barWidth, barStyle, bg));
        }

        return SegmentGrid.Join(outLines);
    }

    private static List<Segment> FrameLine(int maxWidth, int barWidth, Style barStyle, Style bg)
    {
        var row = new List<Segment>();
        if (barWidth > 0)
        {
            row.Add(new Segment(AccentGlyph, barStyle, null));
        }

        var fill = maxWidth - barWidth;
        if (fill > 0)
        {
            row.Add(new Segment(new string(' ', fill), bg, null));
        }

        return row;
    }
}
