// <copyright file="Theme.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Themes

import GSharp.Repl.Tokens
import Spectre.Console
import System
import System.Collections.Generic

/// A complete palette: every widget consumes (cref:Tokens.Tokens), which reads
/// from (cref:Current). Switching theme is a single (cref:Use(string)) call.
class Theme {
    prop Name string {
        get;
        init;
    }

    prop TextPrimary SemanticColor {
        get;
        init;
    }

    prop TextSecondary SemanticColor {
        get;
        init;
    }

    prop TextTertiary SemanticColor {
        get;
        init;
    }

    prop StatusInfo SemanticColor {
        get;
        init;
    }

    prop StatusSuccess SemanticColor {
        get;
        init;
    }

    prop StatusWarning SemanticColor {
        get;
        init;
    }

    prop StatusError SemanticColor {
        get;
        init;
    }

    prop Brand SemanticColor {
        get;
        init;
    }

    prop Selected SemanticColor {
        get;
        init;
    }

    prop BorderNeutral SemanticColor {
        get;
        init;
    }

    prop CellBackground SemanticColor {
        get;
        init;
    }

    prop InputBackground SemanticColor {
        get;
        init;
    }

    prop Keyword SemanticColor {
        get;
        init;
    }

    prop Number SemanticColor {
        get;
        init;
    }

    prop StringLit SemanticColor {
        get;
        init;
    }

    prop Comment SemanticColor {
        get;
        init;
    }

    prop Identifier SemanticColor {
        get;
        init;
    }

    shared {
        private var _current Theme = Themes.Amber

        prop Current Theme {
            get {
                return _current
            }
            private set {
                _current = value
            }
        }

        private let _available IReadOnlyList[Theme] = []Theme{
            Themes.Amber,
            Themes.Synthwave,
            Themes.Dark,
            Themes.Light,
            Themes.GithubLight,
            Themes.WarmPaper
        }

        prop Available IReadOnlyList[Theme] {
            get {
                return _available
            }
        }

        func Use(name string) {
            for t in Available {
                if string.Equals(t.Name, name, StringComparison.OrdinalIgnoreCase) {
                    Current = t
                    return
                }
            }
            throw ArgumentException("Unknown theme '$name'. Known: ${string.Join(", ", AvailableNames())}.", "name")
        }

        func Cycle() {
            var i = 0
            for var n = 0; n < Available.Count; n++ {
                if object.ReferenceEquals(Available[n], Current) {
                    i = n
                    break
                }
            }
            Current = Available[(i + 1) % Available.Count]
        }

        func Reset() -> Current = Themes.Synthwave

        func AvailableNames() sequence[string] {
            for t in Available {
                yield t.Name
            }
        }
    }
}

/// Built-in theme palettes.
shared class Themes {
    private let _amber Theme = Theme{
        Name: "amber",
        TextPrimary: SemanticColor(Color.White),
        TextSecondary: SemanticColor(Color.Grey85),
        TextTertiary: SemanticColor(Color.Grey50),
        StatusInfo: SemanticColor(Color.Gold1),
        StatusSuccess: SemanticColor(Color.Green),
        StatusWarning: SemanticColor(Color.Gold1),
        StatusError: SemanticColor(Color.Red),
        Brand: SemanticColor(Color.Orange1),
        Selected: SemanticColor(Color.Orange1),
        BorderNeutral: SemanticColor(Color.Grey50),
        CellBackground: SemanticColor(Color.Grey11),
        InputBackground: SemanticColor(Color.Grey19),
        Keyword: SemanticColor(Color.Orange1),
        Number: SemanticColor(Color.Gold1),
        StringLit: SemanticColor(Color.Gold1),
        Comment: SemanticColor(Color.Green),
        Identifier: SemanticColor(Color.Gold1)
    }

    prop Amber Theme {
        get {
            return _amber
        }
    }

    private let _synthwave Theme = Theme{
        Name: "synthwave",
        TextPrimary: SemanticColor(Color.White),
        TextSecondary: SemanticColor(Color.Grey85),
        TextTertiary: SemanticColor(Color.Grey50),
        StatusInfo: SemanticColor(Color.SpringGreen2),
        StatusSuccess: SemanticColor(Color.Green),
        StatusWarning: SemanticColor(Color.Yellow),
        StatusError: SemanticColor(Color.Red),
        Brand: SemanticColor(Color.MediumPurple2),
        Selected: SemanticColor(Color.MediumPurple2),
        BorderNeutral: SemanticColor(Color.Grey50),
        CellBackground: SemanticColor(Color.Grey11),
        InputBackground: SemanticColor(Color.Grey19),
        Keyword: SemanticColor(Color.MediumPurple2),
        Number: SemanticColor(Color.SpringGreen2),
        StringLit: SemanticColor(Color.Orange1),
        Comment: SemanticColor(Color.Green),
        Identifier: SemanticColor(Color.Gold1)
    }

    prop Synthwave Theme {
        get {
            return _synthwave
        }
    }

    private let _dark Theme = Theme{
        Name: "dark",
        TextPrimary: SemanticColor(Color.White),
        TextSecondary: SemanticColor(Color.Grey85),
        TextTertiary: SemanticColor(Color.Grey42),
        StatusInfo: SemanticColor(Color.Cyan1),
        StatusSuccess: SemanticColor(Color.Green),
        StatusWarning: SemanticColor(Color.Yellow),
        StatusError: SemanticColor(Color.Red),
        Brand: SemanticColor(Color.DeepSkyBlue1),
        Selected: SemanticColor(Color.DeepSkyBlue1),
        BorderNeutral: SemanticColor(Color.Grey42),
        CellBackground: SemanticColor(Color.Grey11),
        InputBackground: SemanticColor(Color.Grey19),
        Keyword: SemanticColor(Color.DeepSkyBlue1),
        Number: SemanticColor(Color.Cyan1),
        StringLit: SemanticColor(Color.Orange1),
        Comment: SemanticColor(Color.Green),
        Identifier: SemanticColor(Color.Gold1)
    }

    prop Dark Theme {
        get {
            return _dark
        }
    }

    /// Slate-on-paper: light backgrounds with dark, readable text and accents.
    private let _light Theme = Theme{
        Name: "light",
        TextPrimary: SemanticColor(Color.Grey11),
        TextSecondary: SemanticColor(Color.Grey27),
        TextTertiary: SemanticColor(Color.Grey42),
        StatusInfo: SemanticColor(Color.DarkGreen),
        StatusSuccess: SemanticColor(Color.DarkGreen),
        StatusWarning: SemanticColor(Color.DarkOrange3),
        StatusError: SemanticColor(Color.Red3),
        Brand: SemanticColor(Color.Blue),
        Selected: SemanticColor(Color.Blue),
        BorderNeutral: SemanticColor(Color.Grey42),
        CellBackground: SemanticColor(Color.Grey93),
        InputBackground: SemanticColor(Color.Grey85),
        Keyword: SemanticColor(Color.Blue),
        Number: SemanticColor(Color.DarkGreen),
        StringLit: SemanticColor(Color.DarkOrange3),
        Comment: SemanticColor(Color.Grey42),
        Identifier: SemanticColor(Color(133, 94, 0))
    }

    prop Light Theme {
        get {
            return _light
        }
    }

    /// GitHub-light style: crisp white canvas with a cooler blue accent.
    private let _githubLight Theme = Theme{
        Name: "github-light",
        TextPrimary: SemanticColor(Color.Grey11),
        TextSecondary: SemanticColor(Color.Grey30),
        TextTertiary: SemanticColor(Color.Grey46),
        StatusInfo: SemanticColor(Color(26, 127, 55)),
        StatusSuccess: SemanticColor(Color(26, 127, 55)),
        StatusWarning: SemanticColor(Color(154, 103, 0)),
        StatusError: SemanticColor(Color(207, 34, 46)),
        Brand: SemanticColor(Color(9, 105, 218)),
        Selected: SemanticColor(Color(9, 105, 218)),
        BorderNeutral: SemanticColor(Color.Grey46),
        CellBackground: SemanticColor(Color.Grey100),
        InputBackground: SemanticColor(Color.Grey93),
        Keyword: SemanticColor(Color(9, 105, 218)),
        Number: SemanticColor(Color(26, 127, 55)),
        StringLit: SemanticColor(Color(129, 41, 27)),
        Comment: SemanticColor(Color.Grey46),
        Identifier: SemanticColor(Color(130, 80, 223))
    }

    prop GithubLight Theme {
        get {
            return _githubLight
        }
    }

    /// Warm paper / sepia: off-white canvas with warm brown text and accents.
    private let _warmPaper Theme = Theme{
        Name: "warm-paper",
        TextPrimary: SemanticColor(Color(59, 44, 26)),
        TextSecondary: SemanticColor(Color(94, 74, 51)),
        TextTertiary: SemanticColor(Color(140, 116, 89)),
        StatusInfo: SemanticColor(Color(64, 110, 32)),
        StatusSuccess: SemanticColor(Color(64, 110, 32)),
        StatusWarning: SemanticColor(Color(163, 92, 0)),
        StatusError: SemanticColor(Color(178, 34, 34)),
        Brand: SemanticColor(Color(159, 82, 0)),
        Selected: SemanticColor(Color(159, 82, 0)),
        BorderNeutral: SemanticColor(Color(140, 116, 89)),
        CellBackground: SemanticColor(Color.Cornsilk1),
        InputBackground: SemanticColor(Color.Wheat1),
        Keyword: SemanticColor(Color(159, 82, 0)),
        Number: SemanticColor(Color(64, 110, 32)),
        StringLit: SemanticColor(Color(140, 90, 30)),
        Comment: SemanticColor(Color(140, 116, 89)),
        Identifier: SemanticColor(Color(120, 60, 140))
    }

    prop WarmPaper Theme {
        get {
            return _warmPaper
        }
    }
}
