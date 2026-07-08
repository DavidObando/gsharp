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
    public static Theme Current { get; private set; } = Themes.Amber;

    public static IReadOnlyList<Theme> Available { get; } = new[]
    {
        Themes.Amber,
        Themes.Synthwave,
        Themes.Dark,
        Themes.Light,
        Themes.GithubLight,
        Themes.WarmPaper,
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

    public required SemanticColor CellBackground { get; init; }

    public required SemanticColor InputBackground { get; init; }

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

    public static void Reset() => Current = Themes.Synthwave;

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
        CellBackground = new(Color.Grey11),
        InputBackground = new(Color.Grey19),
        Keyword = new(Color.Orange1),
        Number = new(Color.Gold1),
        StringLit = new(Color.Gold1),
        Comment = new(Color.Green),
        Identifier = new(Color.Gold1),
    };

    public static Theme Synthwave { get; } = new()
    {
        Name = "synthwave",
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
        CellBackground = new(Color.Grey11),
        InputBackground = new(Color.Grey19),
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
        CellBackground = new(Color.Grey11),
        InputBackground = new(Color.Grey19),
        Keyword = new(Color.DeepSkyBlue1),
        Number = new(Color.Cyan1),
        StringLit = new(Color.Orange1),
        Comment = new(Color.Green),
        Identifier = new(Color.Gold1),
    };

    /// <summary>Slate-on-paper: light backgrounds with dark, readable text and accents.</summary>
    public static Theme Light { get; } = new()
    {
        Name = "light",
        TextPrimary = new(Color.Grey11),
        TextSecondary = new(Color.Grey27),
        TextTertiary = new(Color.Grey42),
        StatusInfo = new(Color.DarkGreen),
        StatusSuccess = new(Color.DarkGreen),
        StatusWarning = new(Color.DarkOrange3),
        StatusError = new(Color.Red3),
        Brand = new(Color.Blue),
        Selected = new(Color.Blue),
        BorderNeutral = new(Color.Grey42),
        CellBackground = new(Color.Grey93),
        InputBackground = new(Color.Grey85),
        Keyword = new(Color.Blue),
        Number = new(Color.DarkGreen),
        StringLit = new(Color.DarkOrange3),
        Comment = new(Color.Grey42),
        Identifier = new(new Color(133, 94, 0)),
    };

    /// <summary>GitHub-light style: crisp white canvas with a cooler blue accent.</summary>
    public static Theme GithubLight { get; } = new()
    {
        Name = "github-light",
        TextPrimary = new(Color.Grey11),
        TextSecondary = new(Color.Grey30),
        TextTertiary = new(Color.Grey46),
        StatusInfo = new(new Color(26, 127, 55)),
        StatusSuccess = new(new Color(26, 127, 55)),
        StatusWarning = new(new Color(154, 103, 0)),
        StatusError = new(new Color(207, 34, 46)),
        Brand = new(new Color(9, 105, 218)),
        Selected = new(new Color(9, 105, 218)),
        BorderNeutral = new(Color.Grey46),
        CellBackground = new(Color.Grey100),
        InputBackground = new(Color.Grey93),
        Keyword = new(new Color(9, 105, 218)),
        Number = new(new Color(26, 127, 55)),
        StringLit = new(new Color(129, 41, 27)),
        Comment = new(Color.Grey46),
        Identifier = new(new Color(130, 80, 223)),
    };

    /// <summary>Warm paper / sepia: off-white canvas with warm brown text and accents.</summary>
    public static Theme WarmPaper { get; } = new()
    {
        Name = "warm-paper",
        TextPrimary = new(new Color(59, 44, 26)),
        TextSecondary = new(new Color(94, 74, 51)),
        TextTertiary = new(new Color(140, 116, 89)),
        StatusInfo = new(new Color(64, 110, 32)),
        StatusSuccess = new(new Color(64, 110, 32)),
        StatusWarning = new(new Color(163, 92, 0)),
        StatusError = new(new Color(178, 34, 34)),
        Brand = new(new Color(159, 82, 0)),
        Selected = new(new Color(159, 82, 0)),
        BorderNeutral = new(new Color(140, 116, 89)),
        CellBackground = new(Color.Cornsilk1),
        InputBackground = new(Color.Wheat1),
        Keyword = new(new Color(159, 82, 0)),
        Number = new(new Color(64, 110, 32)),
        StringLit = new(new Color(140, 90, 30)),
        Comment = new(new Color(140, 116, 89)),
        Identifier = new(new Color(120, 60, 140)),
    };
}
