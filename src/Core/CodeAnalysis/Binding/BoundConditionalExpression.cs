#nullable disable

// <copyright file="BoundConditionalExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0062: bound representation of a general two-arm conditional (ternary)
/// expression of the form <c>&lt;cond&gt; ? &lt;ifTrue&gt; : &lt;ifFalse&gt;</c>.
/// Only one arm is evaluated at runtime. The result type is the common type
/// chosen by the binder using identity / implicit conversion / numeric
/// tie-break rules; both arm values are already converted to that result type.
/// </summary>
public sealed class BoundConditionalExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundConditionalExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="condition">The bound condition (typed <c>bool</c>).</param>
    /// <param name="whenTrue">The bound true-branch expression, already converted to <paramref name="type"/>.</param>
    /// <param name="whenFalse">The bound false-branch expression, already converted to <paramref name="type"/>.</param>
    /// <param name="type">The common result type chosen for the conditional.</param>
    public BoundConditionalExpression(
        SyntaxNode syntax,
        BoundExpression condition,
        BoundExpression whenTrue,
        BoundExpression whenFalse,
        TypeSymbol type)
        : base(syntax)
    {
        Condition = condition;
        WhenTrue = whenTrue;
        WhenFalse = whenFalse;
        Type = type;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ConditionalExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the bound condition (typed <c>bool</c>).</summary>
    public BoundExpression Condition { get; }

    /// <summary>Gets the bound true-branch expression.</summary>
    public BoundExpression WhenTrue { get; }

    /// <summary>Gets the bound false-branch expression.</summary>
    public BoundExpression WhenFalse { get; }
}
