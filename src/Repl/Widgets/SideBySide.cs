// <copyright file="SideBySide.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>
/// Composites two renderables into fixed-width columns separated by a gap, at the segment
/// level. Unlike a Spectre <c>Grid</c>, it emits line breaks only <em>between</em> lines
/// (no trailing break), so it can be nested inside deterministic fixed-height layouts.
/// </summary>
public sealed class SideBySide : Renderable
{
    private readonly IRenderable left;
    private readonly IRenderable right;
    private readonly int leftWidth;
    private readonly int gap;
    private readonly int rightWidth;
    private readonly Style? fill;

    public SideBySide(IRenderable left, int leftWidth, int gap, IRenderable right, int rightWidth, Style? fill = null)
    {
        this.left = left ?? throw new ArgumentNullException(nameof(left));
        this.right = right ?? throw new ArgumentNullException(nameof(right));
        this.leftWidth = Math.Max(1, leftWidth);
        this.gap = Math.Max(0, gap);
        this.rightWidth = Math.Max(1, rightWidth);
        this.fill = fill;
    }

    protected override Measurement Measure(RenderOptions options, int maxWidth)
        => new(maxWidth, maxWidth);

    protected override IEnumerable<Segment> Render(RenderOptions options, int maxWidth)
    {
        var leftLines = Segment.SplitLines(left.Render(options, leftWidth));
        var rightLines = Segment.SplitLines(right.Render(options, rightWidth));
        var rows = Math.Max(leftLines.Count, rightLines.Count);

        var outLines = new List<List<Segment>>(rows);
        for (var i = 0; i < rows; i++)
        {
            var row = new List<Segment>();
            row.AddRange(SegmentGrid.PadLine(i < leftLines.Count ? leftLines[i] : new SegmentLine(), leftWidth, fill));
            if (gap > 0)
            {
                row.Add(new Segment(new string(' ', gap), fill ?? Style.Plain, null));
            }

            row.AddRange(SegmentGrid.PadLine(i < rightLines.Count ? rightLines[i] : new SegmentLine(), rightWidth, fill));
            outLines.Add(row);
        }

        return SegmentGrid.Join(outLines);
    }
}
