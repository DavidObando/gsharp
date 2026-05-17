// <copyright file="BoundExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression.
/// </summary>
public abstract class BoundExpression : BoundNode
{
    /// <summary>
    /// Gets the bound expression type.
    /// </summary>
    public abstract TypeSymbol Type { get; }
}
