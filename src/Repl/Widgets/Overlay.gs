// <copyright file="Overlay.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Widgets

import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.Linq

/// Composites a modal renderable centered on top of a full-screen base frame, at the
/// segment level, so the surrounding chrome (header, sidebar, input, footer) stays visible
/// behind it. Used for the `/` command palette.
class Overlay : Renderable, IRenderable {
    private let baseFrame IRenderable
    private let modal IRenderable
    private let modalWidth int32

    init(baseFrame IRenderable, modal IRenderable, modalWidth int32) {
        this.baseFrame = baseFrame ?? throw ArgumentNullException("baseFrame")
        this.modal = modal ?? throw ArgumentNullException("modal")
        this.modalWidth = Math.Max(1, modalWidth)
    }

    protected override func Measure(options RenderOptions, maxWidth int32) Measurement -> Measurement(
        maxWidth,
        maxWidth
    )

    protected override func Render(options RenderOptions, maxWidth int32) IEnumerable[Segment] {
        let baseLines = Segment
            .SplitLines(baseFrame.Render(options, maxWidth))
            .Select((l SegmentLine) -> List[Segment](l))
            .ToList()
        let mw = Math.Min(modalWidth, maxWidth)
        let modalLines = Segment.SplitLines(modal.Render(options, mw))
        let left = Math.Max(0, (maxWidth - mw) / 2)
        let top = Math.Max(0, (baseLines.Count - modalLines.Count) / 2)
        for var j = 0; j < modalLines.Count; j++ {
            let idx = top + j
            if idx < 0 || idx >= baseLines.Count {
                continue
            }
            baseLines[idx] = Compose(baseLines[idx], left, modalLines[j], mw, maxWidth)
        }
        return SegmentGrid.Join(baseLines)
    }

    shared {
        private func Compose(
            baseLine List[Segment],
            left int32,
            modalLine IReadOnlyList[Segment],
            mw int32,
            totalWidth int32
        ) List[Segment] {
            let row = List[Segment]()
            row.AddRange(SegmentGrid.Slice(baseLine, 0, left))
            var used = 0
            for seg in modalLine {
                row.Add(seg)
                used += seg.CellCount()
            }
            if used < mw {
                row.Add(Segment(String(' ', mw - used)))
            }
            row.AddRange(SegmentGrid.Slice(baseLine, left + mw, totalWidth))
            return row
        }
    }
}
