// <copyright file="Theme.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Repl.Tokens;
using Spectre.Console;

namespace GSharp.Repl.Themes;

/// <summary>
/// A complete palette: every widget consumes <see cref="Tokens.Tokens"/>, which reads
/// from <see cref="Current"/>. Switching theme is a single <see cref="Use(string)"/> call.
/// </summary>
public sealed class Theme
{
    public static Theme Current { get; private set; } = Themes.Default;

    public static IReadOnlyList<Theme> Available { get; } = new[]
    {
        Themes.Default,
        Themes.Mono,
        Themes.HighContrast,
    };

    public required string Name { get; init; }

    public required SemanticColor TextPrimary { get; init; }

    public required SemanticColor TextSecondary { get; init; }

    public required SemanticColor TextTertiary { get; init; }

    public required SemanticColor StatusInfo { get; init; }

    public required SemanticColor StatusSuccess { get; init; }

    public required SemanticColor StatusWarning { get; init; }

    public required SemanticColor StatusError { get; init; }

    public required SemanticColor Brand { get; init; }

    public required SemanticColor Selected { get; init; }

    public required SemanticColor BorderNeutral { get; init; }

    public required SemanticColor Keyword { get; init; }

    public required SemanticColor Number { get; init; }

    public required SemanticColor StringLit { get; init; }

    public required SemanticColor Comment { get; init; }

    public required SemanticColor Identifier { get; init; }

    public static void Use(string name)
    {
        foreach (var t in Available)
        {
            if (string.Equals(t.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                Current = t;
                return;
            }
        }

        throw new ArgumentException($"Unknown theme '{name}'. Known: {string.Join(", ", AvailableNames())}.", nameof(name));
    }

    public static void Reset() => Current = Themes.Default;

    public static IEnumerable<string> AvailableNames()
    {
        foreach (var t in Available)
        {
            yield return t.Name;
        }
    }
}

/// <summary>Built-in theme palettes.</summary>
public static class Themes
{
    public static Theme Default { get; } = new()
    {
        Name = "Default",
        TextPrimary = new(Color.White),
        TextSecondary = new(Color.Grey85),
        TextTertiary = new(Color.Grey50),
        StatusInfo = new(Color.SkyBlue1),
        StatusSuccess = new(Color.Green),
        StatusWarning = new(Color.Yellow),
        StatusError = new(Color.Red),
        Brand = new(Color.Aqua),
        Selected = new(Color.DodgerBlue1),
        BorderNeutral = new(Color.Grey50),
        Keyword = new(Color.DodgerBlue1),
        Number = new(Color.Aqua),
        StringLit = new(Color.Orange1),
        Comment = new(Color.Green),
        Identifier = new(Color.Grey85),
    };

    public static Theme Mono { get; } = new()
    {
        Name = "Mono",
        TextPrimary = new(Color.Default),
        TextSecondary = new(Color.Default),
        TextTertiary = new(Color.Default),
        StatusInfo = new(Color.Default),
        StatusSuccess = new(Color.Default),
        StatusWarning = new(Color.Default),
        StatusError = new(Color.Default),
        Brand = new(Color.Default),
        Selected = new(Color.Default),
        BorderNeutral = new(Color.Default),
        Keyword = new(Color.Default),
        Number = new(Color.Default),
        StringLit = new(Color.Default),
        Comment = new(Color.Default),
        Identifier = new(Color.Default),
    };

    public static Theme HighContrast { get; } = new()
    {
        Name = "HighContrast",
        TextPrimary = new(Color.White),
        TextSecondary = new(Color.White),
        TextTertiary = new(Color.Silver),
        StatusInfo = new(Color.Aqua),
        StatusSuccess = new(Color.Lime),
        StatusWarning = new(Color.Yellow),
        StatusError = new(Color.Red),
        Brand = new(Color.Aqua),
        Selected = new(Color.Yellow),
        BorderNeutral = new(Color.White),
        Keyword = new(Color.Aqua),
        Number = new(Color.Lime),
        StringLit = new(Color.Yellow),
        Comment = new(Color.Silver),
        Identifier = new(Color.White),
    };
}
