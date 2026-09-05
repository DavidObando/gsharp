// <copyright file="BoundCallOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// The shape shared by every bound node that CALLS a method (ADR-0169, issue
/// #3920).
/// </summary>
/// <remarks>
/// <para>
/// G# binds a call to three different nodes depending on where the callee comes
/// from: <see cref="BoundCallExpression"/> for a same-compilation function,
/// <see cref="BoundImportedCallExpression"/> for a static call into metadata,
/// and <see cref="BoundImportedInstanceCallExpression"/> for an instance call
/// into metadata. Roslyn models all three as one <c>IInvocationOperation</c>.
/// </para>
/// <para>
/// The split is a codegen distinction, not a program-meaning one, and an
/// analyzer that does not know it silently sees a fraction of the calls in the
/// program — which is how the migrated GSA0002 never saw a single
/// <c>object.ReferenceEquals</c>, the only call shape it exists to police. The
/// concrete nodes and their <see cref="BoundNode.Kind"/> values are unchanged.
/// </para>
/// </remarks>
public abstract class BoundCallOperationExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundCallOperationExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    private protected BoundCallOperationExpression(SyntaxNode? syntax)
        : base(syntax)
    {
    }

    /// <summary>
    /// Gets the symbol of the called method — the Roslyn
    /// <c>IInvocationOperation.TargetMethod</c> analogue. Typed as
    /// <see cref="CallableSymbol"/>, not bare <see cref="Symbol"/>: an
    /// imported callee is an <see cref="ImportedFunctionSymbol"/> and a
    /// same-compilation one a <see cref="FunctionSymbol"/>, and the shared
    /// base carries the members the Roslyn call-site surface maps onto
    /// (<c>Type</c> for <c>ReturnType</c>, <c>OverriddenMethod</c>) so
    /// widening the node side does not narrow the symbol side.
    /// </summary>
    public abstract CallableSymbol CalledFunction { get; }

    /// <summary>Gets the arguments, in source order.</summary>
    public abstract ImmutableArray<BoundExpression> Arguments { get; }
}
