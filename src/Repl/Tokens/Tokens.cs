// <copyright file="Tokens.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Themes;

namespace GSharp.Repl.Tokens;

/// <summary>
/// The single set of semantic tokens every widget reads from. Components consume tokens,
/// never raw colours — swapping the theme recolours the whole UI in one place.
/// </summary>
public static class Tokens
{
    public static SemanticColor TextPrimary => Theme.Current.TextPrimary;

    public static SemanticColor TextSecondary => Theme.Current.TextSecondary;

    public static SemanticColor TextTertiary => Theme.Current.TextTertiary;

    public static SemanticColor StatusInfo => Theme.Current.StatusInfo;

    public static SemanticColor StatusSuccess => Theme.Current.StatusSuccess;

    public static SemanticColor StatusWarning => Theme.Current.StatusWarning;

    public static SemanticColor StatusError => Theme.Current.StatusError;

    public static SemanticColor Brand => Theme.Current.Brand;

    public static SemanticColor Selected => Theme.Current.Selected;

    public static SemanticColor BorderNeutral => Theme.Current.BorderNeutral;

    public static SemanticColor Keyword => Theme.Current.Keyword;

    public static SemanticColor Number => Theme.Current.Number;

    public static SemanticColor StringLit => Theme.Current.StringLit;

    public static SemanticColor Comment => Theme.Current.Comment;

    public static SemanticColor Identifier => Theme.Current.Identifier;
}
