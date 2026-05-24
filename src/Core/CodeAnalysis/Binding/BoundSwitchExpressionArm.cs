// <copyright file="BoundSwitchExpressionArm.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound arm of a switch expression.
/// </summary>
public sealed class BoundSwitchExpressionArm : BoundNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundSwitchExpressionArm"/> class.
    /// </summary>
    /// <param name="value">The case value expression, or null for <c>default</c>.</param>
    /// <param name="result">The result expression.</param>
    public BoundSwitchExpressionArm(BoundExpression value, BoundExpression result)
    {
        Value = value;
        Result = result;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.SwitchExpressionArm;

    /// <summary>Gets the case value expression, or null when this arm is <c>default</c>.</summary>
    public BoundExpression Value { get; }

    /// <summary>Gets the result expression.</summary>
    public BoundExpression Result { get; }

    /// <summary>Gets a value indicating whether this is the <c>default</c> arm.</summary>
    public bool IsDefault => Value == null;
}
