// <copyright file="TypeParameterConstraint.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>Constraint kind for a <see cref="TypeParameterSymbol"/> (Phase 4.1 / ADR-0020; widened in Phase 4.2).</summary>
public enum TypeParameterConstraint
{
    /// <summary>Default constraint: any type.</summary>
    Any,

    /// <summary>Phase 4.2: <c>comparable</c> — supports <c>==</c>/<c>!=</c>.</summary>
    Comparable,
}
