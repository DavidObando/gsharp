// <copyright file="FixedHeight.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>
/// Forces a child renderable to occupy exactly a fixed number of lines: it is truncated
/// (keeping the top) when too tall, and padded with blank lines when too short. Emits line
/// breaks only <em>between</em> lines (no trailing break) so it composes into deterministic
/// fixed-height layouts.
/// </summary>
public sealed class FixedHeight : Renderable
{
    private readonly IRenderable child;
    private readonly int height;

    public FixedHeight(IRenderable child, int height)
    {
        this.child = child ?? throw new ArgumentNullException(nameof(child));
        this.height = Math.Max(1, height);
    }

    protected override Measurement Measure(RenderOptions options, int maxWidth)
        => new(maxWidth, maxWidth);

    protected override IEnumerable<Segment> Render(RenderOptions options, int maxWidth)
    {
        var lines = Segment.SplitLines(child.Render(options, maxWidth))
            .Select(l => SegmentGrid.PadLine(l, maxWidth))
            .ToList();

        if (lines.Count > height)
        {
            lines = lines.Take(height).ToList();
        }
        else
        {
            while (lines.Count < height)
            {
                lines.Add(new List<Segment>());
            }
        }

        return SegmentGrid.Join(lines);
    }
}
