// <copyright file="TypeParameterSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A generic type-parameter declared on a generic function or type (Phase 4.1 / ADR-0020).
/// At the binder level it behaves like a stand-in <see cref="TypeSymbol"/>; at call sites
/// it is substituted with a concrete type argument either from an explicit type-argument
/// list or via inference from value arguments.
/// </summary>
public sealed class TypeParameterSymbol : TypeSymbol
{
    /// <summary>Initializes a new instance of the <see cref="TypeParameterSymbol"/> class.</summary>
    /// <param name="name">The type-parameter name (e.g. <c>T</c>).</param>
    /// <param name="ordinal">The zero-based position of this parameter in its declaring list.</param>
    /// <param name="constraint">The constraint kind (Phase 4.1: only <see cref="TypeParameterConstraint.Any"/>; Phase 4.2 widens this).</param>
    /// <param name="variance">The variance modifier (Phase 4.3 / ADR-0021).</param>
    public TypeParameterSymbol(string name, int ordinal, TypeParameterConstraint constraint, TypeParameterVariance variance)
        : base(name)
    {
        Ordinal = ordinal;
        Constraint = constraint;
        Variance = variance;
    }

    /// <summary>Gets the zero-based ordinal of this type parameter in its declaring list.</summary>
    public int Ordinal { get; }

    /// <summary>Gets the constraint applied to this type parameter (Phase 4.2 will add comparable / sealed-interface bounds).</summary>
    public TypeParameterConstraint Constraint { get; }

    /// <summary>Gets the variance modifier (Phase 4.3 / ADR-0021).</summary>
    public TypeParameterVariance Variance { get; }
}
