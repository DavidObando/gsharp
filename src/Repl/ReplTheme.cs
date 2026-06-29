// <copyright file="ReplTheme.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace GSharp.Repl;

/// <summary>
/// A named color theme for the REPL chrome.
/// </summary>
/// <param name="Name">The theme name shown in the header.</param>
/// <param name="Brand">Brand accent color (header, borders, prompt).</param>
/// <param name="Accent">Secondary accent (status, keybar highlights).</param>
/// <param name="Muted">Muted color for secondary text.</param>
internal sealed record ReplTheme(string Name, string Brand, string Accent, string Muted)
{
    private static readonly IReadOnlyList<ReplTheme> All = new[]
    {
        new ReplTheme("gsharp", "mediumpurple2", "springgreen2", "grey50"),
        new ReplTheme("dark", "deepskyblue1", "cyan1", "grey42"),
        new ReplTheme("light", "blue", "darkgreen", "grey35"),
        new ReplTheme("amber", "orange1", "gold1", "grey50"),
    };

    /// <summary>Gets the default theme.</summary>
    public static ReplTheme Default => All[0];

    /// <summary>
    /// Returns the theme after the named one, cycling around the registry.
    /// </summary>
    /// <param name="current">The current theme name.</param>
    /// <returns>The next theme.</returns>
    public static ReplTheme Next(string current)
    {
        for (var i = 0; i < All.Count; i++)
        {
            if (All[i].Name == current)
            {
                return All[(i + 1) % All.Count];
            }
        }

        return Default;
    }
}
