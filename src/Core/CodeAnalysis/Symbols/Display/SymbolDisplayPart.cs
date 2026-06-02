// <copyright file="SymbolDisplayPart.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols.Display;

/// <summary>
/// A single classified run of text in a symbol's display, optionally carrying the
/// <see cref="Symbol"/> it refers to (for navigation). The analog of Roslyn's
/// <c>SymbolDisplayPart</c>.
/// </summary>
/// <param name="Kind">The classification of this part.</param>
/// <param name="Text">The literal text of this part.</param>
/// <param name="Symbol">The symbol this part refers to, when applicable.</param>
public readonly record struct SymbolDisplayPart(
    SymbolDisplayPartKind Kind,
    string Text,
    Symbol Symbol = null);
