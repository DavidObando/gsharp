// <copyright file="SymbolInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// The result of a <see cref="SemanticModel.GetSymbolInfo"/> query: the symbol
/// a syntax node refers to, if any. Mirrors Roslyn's <c>SymbolInfo</c> shape
/// (ADR-0169).
/// </summary>
/// <param name="Symbol">The referenced symbol, or <see langword="null"/> when the node does not refer to one.</param>
public readonly record struct SymbolInfo(Symbol? Symbol)
{
    /// <summary>
    /// Gets an empty result.
    /// </summary>
    public static SymbolInfo None => default;
}
