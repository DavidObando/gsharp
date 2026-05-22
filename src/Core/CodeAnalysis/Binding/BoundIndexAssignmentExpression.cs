// <copyright file="BoundIndexAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound indexed assignment <c>target[index] = value</c>.
/// </summary>
public sealed class BoundIndexAssignmentExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundIndexAssignmentExpression"/> class.
    /// </summary>
    /// <param name="target">The target variable holding the array.</param>
    /// <param name="index">The index expression.</param>
    /// <param name="value">The value expression.</param>
    /// <param name="elementType">The element type of the array.</param>
    public BoundIndexAssignmentExpression(
        VariableSymbol target,
        BoundExpression index,
        BoundExpression value,
        TypeSymbol elementType)
    {
        Target = target;
        Index = index;
        Value = value;
        Type = elementType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.IndexAssignmentExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the target variable holding the array.</summary>
    public VariableSymbol Target { get; }

    /// <summary>Gets the index expression.</summary>
    public BoundExpression Index { get; }

    /// <summary>Gets the value expression.</summary>
    public BoundExpression Value { get; }
}
