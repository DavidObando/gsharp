// <copyright file="Dock.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Widgets

import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.Linq

/// Mutable scroll position for a (cref:Dock), in lines scrolled up from the bottom.
class ScrollState {
    /// Gets or sets the number of lines scrolled up from the bottom (0 = pinned to newest content).
    prop Offset int32

    /// Gets the height of the scrollable region as of the last render (for page-sized scrolling).
    private var _lastViewportHeight int32 = 10

    prop LastViewportHeight int32 {
        get {
            return _lastViewportHeight
        }
        internal set {
            _lastViewportHeight = value
        }
    }

    /// Pins the view back to the bottom (newest content).
    func ToBottom() -> Offset = 0

    /// Scrolls up (towards older content) by [`lines`](paramref).
    func ScrollUp(lines int32) -> Offset += Math.Max(0, lines)

    /// Scrolls down (towards newer content) by [`lines`](paramref), clamped at the bottom.
    func ScrollDown(lines int32) -> Offset = Math.Max(0, Offset - Math.Max(0, lines))
}

/// Fills exactly `height` lines: a fixed `footer` docked at the bottom, and a
/// scrollable region above it that gets whatever height remains. The footer is measured at
/// render time, so the scroll region resizes automatically as the footer (input box) grows
/// or shrinks. The scrollable content is top-anchored when it fits, otherwise it shows a
/// window pinned to the newest (bottom) content and driven by (cref:ScrollState).
/// The footer is never clipped by scrolling.
class Dock : Renderable {
    private let scrollable IRenderable
    private let footer IRenderable
    private let height int32
    private let scroll ScrollState
    private let fill Style?

    init(scrollable IRenderable, footer IRenderable, height int32, scroll ScrollState, fill Style? = nil) {
        this.scrollable = scrollable ?? throw ArgumentNullException("scrollable")
        this.footer = footer ?? throw ArgumentNullException("footer")
        this.height = Math.Max(1, height)
        this.scroll = scroll ?? throw ArgumentNullException("scroll")
        this.fill = fill
    }

    protected override func Measure(options RenderOptions, maxWidth int32) Measurement -> Measurement(
        maxWidth,
        maxWidth
    )

    protected override func Render(options RenderOptions, maxWidth int32) IEnumerable[Segment] {
        let footerLines = Segment
            .SplitLines(footer.Render(options, maxWidth))
            .Select((l SegmentLine) -> SegmentGrid.PadLine(l, maxWidth, fill))
            .ToList()
        let viewportHeight = Math.Max(0, height - footerLines.Count)
        var outLines = List[List[Segment]](height)
        if viewportHeight > 0 {
            let lines = Segment.SplitLines(scrollable.Render(options, maxWidth))
            let total = lines.Count
            let maxOffset = Math.Max(0, total - viewportHeight)
            let offset = Math.Clamp(scroll.Offset, 0, maxOffset)
            this.scroll.Offset = offset
            this.scroll.LastViewportHeight = viewportHeight
            if total <= viewportHeight {
                for line in lines {
                    outLines.Add(SegmentGrid.PadLine(line, maxWidth, fill))
                }
                while outLines.Count < viewportHeight {
                    outLines.Add(SegmentGrid.PadLine(List[Segment](), maxWidth, fill))
                }
            } else {
                let start = total - viewportHeight - offset
                for var i = start; i < start + viewportHeight; i++ {
                    outLines.Add(SegmentGrid.PadLine(lines[i], maxWidth, fill))
                }
            }
        }
        outLines.AddRange(footerLines)
        // Guarantee an exact height even if the footer alone overflows (keep the bottom).
        if outLines.Count > height {
            outLines = outLines.Skip(outLines.Count - height).ToList()
        }
        return SegmentGrid.Join(outLines)
    }
}
