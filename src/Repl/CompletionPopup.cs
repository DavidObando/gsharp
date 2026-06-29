// <copyright file="CompletionPopup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using Spectre.Console;

namespace GSharp.Repl;

/// <summary>
/// A windowed, scrolling completion popup. Holds the candidate list, the selected
/// index, and a fixed viewport; <see cref="RenderLines"/> emits the visible window
/// plus an index counter (e.g. <c>3/12</c>).
/// </summary>
internal sealed class CompletionPopup
{
    private readonly IReadOnlyList<CompletionEntry> items;
    private readonly int windowSize;

    /// <summary>
    /// Initializes a new instance of the <see cref="CompletionPopup"/> class.
    /// </summary>
    /// <param name="items">The completion candidates.</param>
    /// <param name="windowSize">Maximum visible rows.</param>
    public CompletionPopup(IReadOnlyList<CompletionEntry> items, int windowSize = 8)
    {
        this.items = items;
        this.windowSize = Math.Max(1, windowSize);
    }

    /// <summary>Gets the selected index.</summary>
    public int Selected { get; private set; }

    /// <summary>Gets the number of candidates.</summary>
    public int Count => items.Count;

    /// <summary>Gets the currently selected entry, or null when empty.</summary>
    public CompletionEntry Current => items.Count == 0 ? null : items[Selected];

    /// <summary>Moves the selection down one row, wrapping.</summary>
    public void Next() => Selected = items.Count == 0 ? 0 : (Selected + 1) % items.Count;

    /// <summary>Moves the selection up one row, wrapping.</summary>
    public void Previous() => Selected = items.Count == 0 ? 0 : (Selected - 1 + items.Count) % items.Count;

    /// <summary>
    /// Renders the visible window of completions as Spectre markup lines.
    /// </summary>
    /// <param name="accent">Accent color for the selected row.</param>
    /// <returns>One markup line per visible candidate plus a trailing counter.</returns>
    public IReadOnlyList<string> RenderLines(string accent = "springgreen2")
    {
        var lines = new List<string>();
        if (items.Count == 0)
        {
            lines.Add("[grey50]no completions[/]");
            return lines;
        }

        var half = windowSize / 2;
        var start = Math.Clamp(Selected - half, 0, Math.Max(0, items.Count - windowSize));
        var end = Math.Min(items.Count, start + windowSize);
        for (var i = start; i < end; i++)
        {
            var entry = items[i];
            var label = Markup.Escape(entry.Label);
            var kind = Markup.Escape(entry.Kind);
            if (i == Selected)
            {
                lines.Add($"[invert {accent}]› {label}[/] [grey50]{kind}[/]");
            }
            else
            {
                lines.Add($"  [white]{label}[/] [grey50]{kind}[/]");
            }
        }

        var counter = (Selected + 1).ToString(CultureInfo.InvariantCulture) + "/" + items.Count.ToString(CultureInfo.InvariantCulture);
        lines.Add($"[grey42]{counter}[/]");
        return lines;
    }
}
