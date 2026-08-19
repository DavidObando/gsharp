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
    /// Gets the compile-time constant value of this expression — the Roslyn
    /// <c>ConstantValue</c> analogue (ADR-0169). <c>HasValue</c> is false
    /// when the expression has no compile-time constant; a constant null
    /// literal reports <c>HasValue</c> true with a null <c>Value</c>.
    /// </summary>
    public virtual OptionalValue ConstantValue => default;
}
