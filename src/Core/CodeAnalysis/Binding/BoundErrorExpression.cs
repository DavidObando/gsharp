// <copyright file="BoundErrorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound error expression.
/// </summary>
public sealed class BoundErrorExpression : BoundExpression
{
    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ErrorExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Error;
}
