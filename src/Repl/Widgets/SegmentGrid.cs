// <copyright file="SegmentGrid.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>
/// Low-level helpers for composing fixed-height frames out of pre-rendered
/// <see cref="Segment"/> lines: joining lines with breaks and slicing a line by
/// cell column (used for overlay compositing). Assumes one cell per character,
/// which holds for the REPL's ASCII/box-glyph content.
/// </summary>
internal static class SegmentGrid
{
    /// <summary>Emits the given lines separated by line breaks, with no trailing break.</summary>
    public static IEnumerable<Segment> Join(IReadOnlyList<List<Segment>> lines)
    {
        for (var i = 0; i < lines.Count; i++)
        {
            if (i > 0)
            {
                yield return Segment.LineBreak;
            }

            foreach (var seg in lines[i])
            {
                yield return seg;
            }
        }
    }

    /// <summary>Pads a rendered line with default-styled spaces up to <paramref name="width"/> cells.</summary>
    public static List<Segment> PadLine(IReadOnlyList<Segment> line, int width)
    {
        var row = new List<Segment>(line.Count + 1);
        var used = 0;
        foreach (var seg in line)
        {
            row.Add(seg);
            used += seg.CellCount();
        }

        if (used < width)
        {
            row.Add(new Segment(new string(' ', width - used)));
        }

        return row;
    }

    /// <summary>
    /// Returns the segments of <paramref name="line"/> covering cell columns
    /// <c>[start, end)</c>, padded with default-styled spaces so the result is exactly
    /// <c>end - start</c> cells wide.
    /// </summary>
    public static List<Segment> Slice(IReadOnlyList<Segment> line, int start, int end)
    {
        var result = new List<Segment>();
        if (end <= start)
        {
            return result;
        }

        var col = 0;
        foreach (var seg in line)
        {
            if (col >= end)
            {
                break;
            }

            var text = seg.Text;
            var len = text.Length;
            var segStart = col;
            var segEnd = col + len;
            var a = Math.Max(start, segStart);
            var b = Math.Min(end, segEnd);
            if (b > a)
            {
                result.Add(new Segment(text.Substring(a - segStart, b - a), seg.Style, null));
            }

            col = segEnd;
        }

        var produced = Math.Max(0, Math.Min(end, col) - start);
        var need = (end - start) - produced;
        if (need > 0)
        {
            result.Add(new Segment(new string(' ', need)));
        }

        return result;
    }
}
