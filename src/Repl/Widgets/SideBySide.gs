// <copyright file="SideBySide.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Widgets

import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.Linq

/// Composites two renderables into fixed-width columns separated by a gap, at the segment
/// level. Unlike a Spectre `Grid`, it emits line breaks only <em>between</em> lines
/// (no trailing break), so it can be nested inside deterministic fixed-height layouts.
class SideBySide : Renderable, IRenderable {
    private let left IRenderable
    private let right IRenderable
    private let leftWidth int32
    private let gap int32
    private let rightWidth int32
    private let fill Style?

    init(left IRenderable, leftWidth int32, gap int32, right IRenderable, rightWidth int32, fill Style? = nil) {
        this.left = left ?? throw ArgumentNullException("left")
        this.right = right ?? throw ArgumentNullException("right")
        this.leftWidth = Math.Max(1, leftWidth)
        this.gap = Math.Max(0, gap)
        this.rightWidth = Math.Max(1, rightWidth)
        this.fill = fill
    }

    protected override func Measure(options RenderOptions, maxWidth int32) Measurement -> Measurement(
        maxWidth,
        maxWidth
    )

    protected override func Render(options RenderOptions, maxWidth int32) IEnumerable[Segment] {
        let leftLines = Segment.SplitLines(left.Render(options, leftWidth))
        let rightLines = Segment.SplitLines(right.Render(options, rightWidth))
        let rows = Math.Max(leftLines.Count, rightLines.Count)
        let outLines = List[List[Segment]](rows)
        for var i = 0; i < rows; i++ {
            let row = List[Segment]()
            row.AddRange(
                SegmentGrid.PadLine(
                    if i < leftLines.Count {
                        leftLines[i]
                    } else {
                        SegmentLine()
                    },
                    leftWidth,
                    fill
                )
            )
            if gap > 0 {
                row.Add(Segment(String(' ', gap), fill ?? Style.Plain, nil))
            }
            row.AddRange(
                SegmentGrid.PadLine(
                    if i < rightLines.Count {
                        rightLines[i]
                    } else {
                        SegmentLine()
                    },
                    rightWidth,
                    fill
                )
            )
            outLines.Add(row)
        }
        return SegmentGrid.Join(outLines)
    }
}
