// <copyright file="SymbolEqualityComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Symbol identity comparer — the Roslyn <c>SymbolEqualityComparer</c>
/// analogue (ADR-0169). G# symbols are reference-unique within a compilation,
/// so identity is reference equality; the type exists so migrated analyzers'
/// <c>SymbolEqualityComparer.Default</c> usage carries over verbatim.
/// </summary>
public sealed class SymbolEqualityComparer : IEqualityComparer<Symbol>
{
    private SymbolEqualityComparer()
    {
    }

    /// <summary>
    /// Gets the singleton comparer.
    /// </summary>
    public static SymbolEqualityComparer Default { get; } = new();

    /// <inheritdoc/>
    public bool Equals(Symbol? x, Symbol? y) => ReferenceEquals(x, y);

    /// <inheritdoc/>
    public int GetHashCode(Symbol obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
}
