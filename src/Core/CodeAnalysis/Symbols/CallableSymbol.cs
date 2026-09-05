// <copyright file="CallableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The shape shared by everything a call site can resolve to — the Roslyn
/// <c>IMethodSymbol</c> analogue at a CALL (ADR-0169, issue #3920).
/// </summary>
/// <remarks>
/// <para>
/// G# has two callee symbols with no common base: <see cref="FunctionSymbol"/>
/// for a same-compilation function and <see cref="ImportedFunctionSymbol"/> for
/// one reached through metadata. Roslyn has one, so
/// <c>IInvocationOperation.TargetMethod</c> reads the same members whichever
/// side the callee lives on.
/// </para>
/// <para>
/// Typing the analyzer surface as bare <see cref="Symbol"/> would have made
/// those reads stop binding: <c>TargetMethod.ReturnType</c> maps to
/// <c>Type</c>, which <see cref="Symbol"/> does not have, so a migrated
/// analyzer that had compiled against the same-compilation-only shape would
/// fail with <c>GS0158: Cannot find member Type</c>. This base carries exactly
/// the members the Roslyn call-site surface maps onto, so widening the node
/// side to cover imported callees does not narrow the symbol side.
/// </para>
/// </remarks>
public abstract class CallableSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CallableSymbol"/> class.
    /// </summary>
    /// <param name="name">The symbol name.</param>
    private protected CallableSymbol(string name)
        : base(name)
    {
    }

    /// <summary>
    /// Gets the type this callable returns — the Roslyn
    /// <c>IMethodSymbol.ReturnType</c> analogue.
    /// </summary>
    public abstract TypeSymbol Type { get; }

    /// <summary>
    /// Gets or sets the callable this one overrides, or <see langword="null"/> — the
    /// Roslyn <c>IMethodSymbol.OverriddenMethod</c> analogue. Null for an
    /// imported callee: G# models no override chain across the metadata
    /// boundary.
    /// </summary>
    public virtual FunctionSymbol? OverriddenMethod
    {
        get => null;
        set => throw new System.NotSupportedException(
            "Only a same-compilation function has an override chain to set.");
    }
}
