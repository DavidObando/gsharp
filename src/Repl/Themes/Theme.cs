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
    public static Theme Current { get; private set; } = Themes.GSharp;

    public static IReadOnlyList<Theme> Available { get; } = new[]
    {
        Themes.GSharp,
        Themes.Dark,
        Themes.Light,
        Themes.Amber,
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

    public static void Cycle()
    {
        var i = 0;
        for (var n = 0; n < Available.Count; n++)
        {
            if (ReferenceEquals(Available[n], Current))
            {
                i = n;
                break;
            }
        }

        Current = Available[(i + 1) % Available.Count];
    }

    public static void Reset() => Current = Themes.GSharp;

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
    public static Theme GSharp { get; } = new()
    {
        Name = "gsharp",
        TextPrimary = new(Color.White),
        TextSecondary = new(Color.Grey85),
        TextTertiary = new(Color.Grey50),
        StatusInfo = new(Color.SpringGreen2),
        StatusSuccess = new(Color.Green),
        StatusWarning = new(Color.Yellow),
        StatusError = new(Color.Red),
        Brand = new(Color.MediumPurple2),
        Selected = new(Color.MediumPurple2),
        BorderNeutral = new(Color.Grey50),
        Keyword = new(Color.MediumPurple2),
        Number = new(Color.SpringGreen2),
        StringLit = new(Color.Orange1),
        Comment = new(Color.Green),
        Identifier = new(Color.Gold1),
    };

    public static Theme Dark { get; } = new()
    {
        Name = "dark",
        TextPrimary = new(Color.White),
        TextSecondary = new(Color.Grey85),
        TextTertiary = new(Color.Grey42),
        StatusInfo = new(Color.Cyan1),
        StatusSuccess = new(Color.Green),
        StatusWarning = new(Color.Yellow),
        StatusError = new(Color.Red),
        Brand = new(Color.DeepSkyBlue1),
        Selected = new(Color.DeepSkyBlue1),
        BorderNeutral = new(Color.Grey42),
        Keyword = new(Color.DeepSkyBlue1),
        Number = new(Color.Cyan1),
        StringLit = new(Color.Orange1),
        Comment = new(Color.Green),
        Identifier = new(Color.Gold1),
    };

    public static Theme Light { get; } = new()
    {
        Name = "light",
        TextPrimary = new(Color.White),
        TextSecondary = new(Color.Grey85),
        TextTertiary = new(Color.Grey35),
        StatusInfo = new(Color.DarkGreen),
        StatusSuccess = new(Color.DarkGreen),
        StatusWarning = new(Color.Gold1),
        StatusError = new(Color.Red),
        Brand = new(Color.Blue),
        Selected = new(Color.Blue),
        BorderNeutral = new(Color.Grey35),
        Keyword = new(Color.Blue),
        Number = new(Color.DarkGreen),
        StringLit = new(Color.Orange1),
        Comment = new(Color.DarkGreen),
        Identifier = new(Color.Gold1),
    };

    public static Theme Amber { get; } = new()
    {
        Name = "amber",
        TextPrimary = new(Color.White),
        TextSecondary = new(Color.Grey85),
        TextTertiary = new(Color.Grey50),
        StatusInfo = new(Color.Gold1),
        StatusSuccess = new(Color.Green),
        StatusWarning = new(Color.Gold1),
        StatusError = new(Color.Red),
        Brand = new(Color.Orange1),
        Selected = new(Color.Orange1),
        BorderNeutral = new(Color.Grey50),
        Keyword = new(Color.Orange1),
        Number = new(Color.Gold1),
        StringLit = new(Color.Gold1),
        Comment = new(Color.Green),
        Identifier = new(Color.Gold1),
    };
}
