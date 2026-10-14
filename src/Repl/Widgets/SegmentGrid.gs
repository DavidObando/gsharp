// <copyright file="SegmentGrid.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Widgets

import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic

/// Low-level helpers for composing fixed-height frames out of pre-rendered
/// (cref:Segment) lines: joining lines with breaks and slicing a line by
/// cell column (used for overlay compositing). Assumes one cell per character,
/// which holds for the REPL's ASCII/box-glyph content.
internal shared class SegmentGrid {
    /// Emits the given lines separated by line breaks, with no trailing break.
    func Join(lines IReadOnlyList[List[Segment]]) sequence[Segment] {
        for var i = 0; i < lines.Count; i++ {
            if i > 0 {
                yield Segment.LineBreak
            }
            for seg in lines[i] {
                yield seg
            }
        }
    }

    /// Pads a rendered line with spaces up to [`width`](paramref) cells. The padding
    /// is styled with [`fill`](paramref) (defaulting to no style, i.e. the terminal's
    /// own background) so callers filling a themed canvas can avoid a black gap.
    func PadLine(line IReadOnlyList[Segment], width int32, fill Style? = nil) List[Segment] {
        let row = List[Segment](line.Count + 1)
        var used = 0
        for seg in line {
            row.Add(seg)
            used += seg.CellCount()
        }
        if used < width {
            row.Add(Segment(String(' ', width - used), fill ?? Style.Plain, nil))
        }
        return row
    }

    /// Returns the segments of [`line`](paramref) covering cell columns
    /// `[start, end)`, padded with default-styled spaces so the result is exactly
    /// `end - start` cells wide.
    func Slice(line IReadOnlyList[Segment], start int32, end int32) List[Segment] {
        let result = List[Segment]()
        if end <= start {
            return result
        }
        var col = 0
        for seg in line {
            if col >= end {
                break
            }
            let text = seg.Text
            let len = text.Length
            let segStart = col
            let segEnd = col + len
            let a = Math.Max(start, segStart)
            let b = Math.Min(end, segEnd)
            if b > a {
                result.Add(Segment(text.Substring(a - segStart, b - a), seg.Style, nil))
            }
            col = segEnd
        }
        let produced = Math.Max(0, Math.Min(end, col) - start)
        let need = (end - start) - produced
        if need > 0 {
            result.Add(Segment(String(' ', need)))
        }
        return result
    }
}
