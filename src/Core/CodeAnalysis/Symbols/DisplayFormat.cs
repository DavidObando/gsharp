// <copyright file="DisplayFormat.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Rendering formats for <see cref="Symbol.ToDisplayString"/> — the collapsed
/// counterpart of Roslyn's <c>SymbolDisplayFormat</c> options (ADR-0169).
/// </summary>
public enum DisplayFormat
{
    /// <summary>
    /// The bare symbol name (Roslyn's minimally-qualified format).
    /// </summary>
    Minimal,

    /// <summary>
    /// <c>global::</c>-prefixed namespace-qualified name, mirroring Roslyn's
    /// fully-qualified format so migrated analyzers' string comparisons carry
    /// over verbatim.
    /// </summary>
    FullyQualified,
}
