// <copyright file="BoundCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound call expression.
/// </summary>
public sealed class BoundCallExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundCallExpression"/> class.
    /// </summary>
    /// <param name="function">The function symbol.</param>
    /// <param name="arguments">The provided arguments.</param>
    public BoundCallExpression(FunctionSymbol function, ImmutableArray<BoundExpression> arguments)
        : this(function, arguments, returnType: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundCallExpression"/> class with an explicit (substituted) return type for generic-call sites (Phase 4.1 / ADR-0020).</summary>
    /// <param name="function">The function symbol.</param>
    /// <param name="arguments">The provided arguments.</param>
    /// <param name="returnType">The (already-substituted) call-site return type, or <c>null</c> to use <c>function.Type</c>.</param>
    public BoundCallExpression(FunctionSymbol function, ImmutableArray<BoundExpression> arguments, TypeSymbol returnType)
    {
        Function = function;
        Arguments = arguments;
        ReturnType = returnType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.CallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => ReturnType ?? Function.Type;

    /// <summary>
    /// Gets the function symbol.
    /// </summary>
    public FunctionSymbol Function { get; }

    /// <summary>
    /// Gets the provided arguments.
    /// </summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>Gets the call-site (post-substitution) return type for generic-function calls, or <c>null</c> for non-generic calls. Phase 4.1 / ADR-0020.</summary>
    public TypeSymbol ReturnType { get; }
}
