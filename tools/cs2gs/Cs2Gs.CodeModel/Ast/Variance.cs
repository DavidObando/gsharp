// <copyright file="Variance.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Variance marker on an interface/delegate type parameter (ADR-0021).
/// </summary>
public enum Variance
{
    /// <summary>Invariant (no marker).</summary>
    None,

    /// <summary>Covariant (<c>out</c>).</summary>
    Out,

    /// <summary>Contravariant (<c>in</c>).</summary>
    In,
}
