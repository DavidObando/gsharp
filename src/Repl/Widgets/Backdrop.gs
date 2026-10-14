// <copyright file="Backdrop.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Widgets

import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic

/// Wraps a child renderable in a solid background block that fills the full available
/// width, in the OpenCode/Copilot-CLI style. Optionally draws a themed one-cell accent
/// bar down the left edge (used by the input box and sidebar) and adds interior padding
/// rows. Emits line breaks <em>between</em> lines only (no trailing break) so callers can
/// compose deterministic fixed-height layouts.
class Backdrop : Renderable, IRenderable {
    private let child IRenderable
    private let background Color
    private let accent Color?
    private let padLeft int32
    private let padRight int32
    private let padTop int32
    private let padBottom int32
    private let minHeight int32

    init(
        child IRenderable,
        background Color,
        accent Color? = nil,
        padLeft int32 = 1,
        padRight int32 = 1,
        padTop int32 = 0,
        padBottom int32 = 0,
        minHeight int32 = 0
    ) {
        this.child = child ?? throw ArgumentNullException("child")
        this.background = background
        this.accent = accent
        this.padLeft = Math.Max(0, padLeft)
        this.padRight = Math.Max(0, padRight)
        this.padTop = Math.Max(0, padTop)
        this.padBottom = Math.Max(0, padBottom)
        this.minHeight = Math.Max(0, minHeight)
    }

    protected override func Measure(options RenderOptions, maxWidth int32) Measurement -> Measurement(
        maxWidth,
        maxWidth
    )

    protected override func Render(options RenderOptions, maxWidth int32) IEnumerable[Segment] {
        let bg = Style(background: background)
        let barStyle = if accent is {} a {
            Style(foreground: a, background: background)
        } else {
            bg
        }
        let barWidth = if accent == nil {
            0
        } else {
            1
        }
        let innerWidth = Math.Max(1, maxWidth - barWidth - padLeft - padRight)
        let lines = Segment.SplitLines(child.Render(options, innerWidth))
        let outLines = List[List[Segment]]()
        for var i = 0; i < padTop; i++ {
            outLines.Add(FrameLine(maxWidth, barWidth, barStyle, bg))
        }
        for line in lines {
            let row = List[Segment]()
            if barWidth > 0 {
                row.Add(Segment(AccentGlyph, barStyle, nil))
            }
            if padLeft > 0 {
                row.Add(Segment(String(' ', padLeft), bg, nil))
            }
            var used = 0
            for seg in line {
                // bg fills in only where the segment has no explicit style of its own
                // (e.g. plain markup text); an already-backgrounded child segment (a
                // nested Backdrop, such as a transcript cell) keeps its own color.
                row.Add(Segment(seg.Text, bg.Combine(seg.Style), nil))
                used += seg.CellCount()
            }
            let fill = maxWidth - barWidth - padLeft - used
            if fill > 0 {
                row.Add(Segment(String(' ', fill), bg, nil))
            }
            outLines.Add(row)
        }
        for var i = 0; i < padBottom; i++ {
            outLines.Add(FrameLine(maxWidth, barWidth, barStyle, bg))
        }
        while outLines.Count < minHeight {
            outLines.Add(FrameLine(maxWidth, barWidth, barStyle, bg))
        }
        return SegmentGrid.Join(outLines)
    }

    shared {
        private const AccentGlyph string = "▏"

        private func FrameLine(maxWidth int32, barWidth int32, barStyle Style, bg Style) List[Segment] {
            let row = List[Segment]()
            if barWidth > 0 {
                row.Add(Segment(AccentGlyph, barStyle, nil))
            }
            let fill = maxWidth - barWidth
            if fill > 0 {
                row.Add(Segment(String(' ', fill), bg, nil))
            }
            return row
        }
    }
}
