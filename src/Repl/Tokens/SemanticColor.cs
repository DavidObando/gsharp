// <copyright file="SemanticColor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Spectre.Console;

namespace GSharp.Repl.Tokens;

/// <summary>
/// A single semantic colour token: a Spectre <see cref="Color"/> wrapped in a strong type
/// so widgets compose with intent (<c>StatusError</c>) rather than raw colour (<c>Red</c>).
/// </summary>
public readonly record struct SemanticColor(Color Value)
{
    public static implicit operator Color(SemanticColor c) => c.Value;

    public static implicit operator Style(SemanticColor c) => new(c.Value);

    public string MarkupOpen() => $"[{Value.ToMarkup()}]";

    public override string ToString() => Value.ToMarkup();
}
