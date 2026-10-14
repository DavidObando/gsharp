// <copyright file="DisplayFormat.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// Rendering formats for (cref:Symbol.ToDisplayString) — the collapsed
/// counterpart of Roslyn's `SymbolDisplayFormat` options (ADR-0169).
enum DisplayFormat {
    Minimal,
    FullyQualified
}
