// <copyright file="Dock.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>Mutable scroll position for a <see cref="Dock"/>, in lines scrolled up from the bottom.</summary>
public sealed class ScrollState
{
    /// <summary>Gets or sets the number of lines scrolled up from the bottom (0 = pinned to newest content).</summary>
    public int Offset { get; set; }

    /// <summary>Gets the height of the scrollable region as of the last render (for page-sized scrolling).</summary>
    public int LastViewportHeight { get; internal set; } = 10;

    /// <summary>Pins the view back to the bottom (newest content).</summary>
    public void ToBottom() => Offset = 0;

    /// <summary>Scrolls up (towards older content) by <paramref name="lines"/>.</summary>
    public void ScrollUp(int lines) => Offset += Math.Max(0, lines);

    /// <summary>Scrolls down (towards newer content) by <paramref name="lines"/>, clamped at the bottom.</summary>
    public void ScrollDown(int lines) => Offset = Math.Max(0, Offset - Math.Max(0, lines));
}

/// <summary>
/// Fills exactly <c>height</c> lines: a fixed <c>footer</c> docked at the bottom, and a
/// scrollable region above it that gets whatever height remains. The footer is measured at
/// render time, so the scroll region resizes automatically as the footer (input box) grows
/// or shrinks. The scrollable content is top-anchored when it fits, otherwise it shows a
/// window pinned to the newest (bottom) content and driven by <see cref="ScrollState"/>.
/// The footer is never clipped by scrolling.
/// </summary>
public sealed class Dock : Renderable
{
    private readonly IRenderable scrollable;
    private readonly IRenderable footer;
    private readonly int height;
    private readonly ScrollState scroll;
    private readonly Style? fill;

    public Dock(IRenderable scrollable, IRenderable footer, int height, ScrollState scroll, Style? fill = null)
    {
        this.scrollable = scrollable ?? throw new ArgumentNullException(nameof(scrollable));
        this.footer = footer ?? throw new ArgumentNullException(nameof(footer));
        this.height = Math.Max(1, height);
        this.scroll = scroll ?? throw new ArgumentNullException(nameof(scroll));
        this.fill = fill;
    }

    protected override Measurement Measure(RenderOptions options, int maxWidth)
        => new(maxWidth, maxWidth);

    protected override IEnumerable<Segment> Render(RenderOptions options, int maxWidth)
    {
        var footerLines = Segment.SplitLines(footer.Render(options, maxWidth))
            .Select(l => SegmentGrid.PadLine(l, maxWidth, fill))
            .ToList();

        var viewportHeight = Math.Max(0, height - footerLines.Count);
        var outLines = new List<List<Segment>>(height);

        if (viewportHeight > 0)
        {
            var lines = Segment.SplitLines(scrollable.Render(options, maxWidth));
            var total = lines.Count;
            var maxOffset = Math.Max(0, total - viewportHeight);
            var offset = Math.Clamp(scroll.Offset, 0, maxOffset);
            scroll.Offset = offset;
            scroll.LastViewportHeight = viewportHeight;

            if (total <= viewportHeight)
            {
                foreach (var line in lines)
                {
                    outLines.Add(SegmentGrid.PadLine(line, maxWidth, fill));
                }

                while (outLines.Count < viewportHeight)
                {
                    outLines.Add(SegmentGrid.PadLine(new List<Segment>(), maxWidth, fill));
                }
            }
            else
            {
                var start = total - viewportHeight - offset;
                for (var i = start; i < start + viewportHeight; i++)
                {
                    outLines.Add(SegmentGrid.PadLine(lines[i], maxWidth, fill));
                }
            }
        }

        outLines.AddRange(footerLines);

        // Guarantee an exact height even if the footer alone overflows (keep the bottom).
        if (outLines.Count > height)
        {
            outLines = outLines.Skip(outLines.Count - height).ToList();
        }

        return SegmentGrid.Join(outLines);
    }
}
