// <copyright file="Tokens.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Tokens

import GSharp.Repl.Themes
import Spectre.Console

/// The single set of semantic tokens every widget reads from. Components consume tokens,
/// never raw colours — swapping the theme recolours the whole UI in one place.
shared class Tokens {
    prop TextPrimary SemanticColor -> Theme.Current.TextPrimary
    prop TextSecondary SemanticColor -> Theme.Current.TextSecondary
    prop TextTertiary SemanticColor -> Theme.Current.TextTertiary
    prop StatusInfo SemanticColor -> Theme.Current.StatusInfo
    prop StatusSuccess SemanticColor -> Theme.Current.StatusSuccess
    prop StatusWarning SemanticColor -> Theme.Current.StatusWarning
    prop StatusError SemanticColor -> Theme.Current.StatusError
    prop Brand SemanticColor -> Theme.Current.Brand
    prop Selected SemanticColor -> Theme.Current.Selected
    prop BorderNeutral SemanticColor -> Theme.Current.BorderNeutral
    prop CellBackground SemanticColor -> Theme.Current.CellBackground

    /// Background for chrome/gaps between larger sections (header, footer, dock fill,
    /// sidebar gutter) — a darker shade of (cref:CellBackground) so those gaps
    /// read as negative space rather than matching or clashing with cell content.
    prop Canvas Color -> Darken(CellBackground.Value, 0.6)

    private func Darken(c Color, factor float64) Color -> Color(
        uint8((float64(c.R) * factor)),
        uint8((float64(c.G) * factor)),
        uint8((float64(c.B) * factor))
    )
    prop InputBackground SemanticColor -> Theme.Current.InputBackground
    prop Keyword SemanticColor -> Theme.Current.Keyword
    prop Number SemanticColor -> Theme.Current.Number
    prop StringLit SemanticColor -> Theme.Current.StringLit
    prop Comment SemanticColor -> Theme.Current.Comment
    prop Identifier SemanticColor -> Theme.Current.Identifier
}
