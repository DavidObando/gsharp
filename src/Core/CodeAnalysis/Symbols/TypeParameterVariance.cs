#nullable disable

// <copyright file="TypeParameterVariance.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>Variance kind for a <see cref="TypeParameterSymbol"/> (Phase 4.3 / ADR-0021).</summary>
public enum TypeParameterVariance
{
    /// <summary>No variance modifier — invariant.</summary>
    None,

    /// <summary><c>in</c> — contravariant.</summary>
    In,

    /// <summary><c>out</c> — covariant.</summary>
    Out,
}
