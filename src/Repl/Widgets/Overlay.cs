// <copyright file="Overlay.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>
/// Composites a modal renderable centered on top of a full-screen base frame, at the
/// segment level, so the surrounding chrome (header, sidebar, input, footer) stays visible
/// behind it. Used for the <c>/</c> command palette.
/// </summary>
public sealed class Overlay : Renderable
{
    private readonly IRenderable baseFrame;
    private readonly IRenderable modal;
    private readonly int modalWidth;

    public Overlay(IRenderable baseFrame, IRenderable modal, int modalWidth)
    {
        this.baseFrame = baseFrame ?? throw new ArgumentNullException(nameof(baseFrame));
        this.modal = modal ?? throw new ArgumentNullException(nameof(modal));
        this.modalWidth = Math.Max(1, modalWidth);
    }

    protected override Measurement Measure(RenderOptions options, int maxWidth)
        => new(maxWidth, maxWidth);

    protected override IEnumerable<Segment> Render(RenderOptions options, int maxWidth)
    {
        var baseLines = Segment.SplitLines(baseFrame.Render(options, maxWidth))
            .Select(l => new List<Segment>(l))
            .ToList();

        var mw = Math.Min(modalWidth, maxWidth);
        var modalLines = Segment.SplitLines(modal.Render(options, mw));

        var left = Math.Max(0, (maxWidth - mw) / 2);
        var top = Math.Max(0, (baseLines.Count - modalLines.Count) / 2);

        for (var j = 0; j < modalLines.Count; j++)
        {
            var idx = top + j;
            if (idx < 0 || idx >= baseLines.Count)
            {
                continue;
            }

            baseLines[idx] = Compose(baseLines[idx], left, modalLines[j], mw, maxWidth);
        }

        return SegmentGrid.Join(baseLines);
    }

    private static List<Segment> Compose(List<Segment> baseLine, int left, IReadOnlyList<Segment> modalLine, int mw, int totalWidth)
    {
        var row = new List<Segment>();
        row.AddRange(SegmentGrid.Slice(baseLine, 0, left));

        var used = 0;
        foreach (var seg in modalLine)
        {
            row.Add(seg);
            used += seg.CellCount();
        }

        if (used < mw)
        {
            row.Add(new Segment(new string(' ', mw - used)));
        }

        row.AddRange(SegmentGrid.Slice(baseLine, left + mw, totalWidth));
        return row;
    }
}
