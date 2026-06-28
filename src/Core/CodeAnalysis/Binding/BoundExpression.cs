#nullable disable

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
    protected BoundExpression(SyntaxNode syntax)
        : base(syntax)
    {
    }

    /// <summary>
    /// Gets the bound expression type.
    /// </summary>
    public abstract TypeSymbol Type { get; }
}
