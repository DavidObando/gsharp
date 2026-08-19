// <copyright file="BoundExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression.
/// </summary>
public abstract class BoundExpression : BoundNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    protected BoundExpression(SyntaxNode? syntax)
        : base(syntax)
    {
    }

    /// <summary>
    /// Gets the bound expression type.
    /// </summary>
    public abstract TypeSymbol Type { get; }

    /// <summary>
    /// Gets the compile-time constant value of this expression, or
    /// <see langword="null"/> when it has none — the (flattened) Roslyn
    /// <c>ConstantValue</c> analogue (ADR-0169). Note a constant null literal
    /// is indistinguishable from "no constant" here; check
    /// <see cref="BoundNodeKind.LiteralExpression"/> for that case.
    /// </summary>
    public virtual object? ConstantValue => null;
}
