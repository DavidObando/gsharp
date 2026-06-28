#nullable disable

// <copyright file="BoundSwitchExpressionArm.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound arm of a switch expression.
/// </summary>
public sealed class BoundSwitchExpressionArm : BoundNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundSwitchExpressionArm"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="pattern">The case pattern, or null for <c>default</c>.</param>
    /// <param name="guard">The optional boolean guard expression (<c>when</c> clause), or null.</param>
    /// <param name="result">The result expression.</param>
    public BoundSwitchExpressionArm(SyntaxNode syntax, BoundPattern pattern, BoundExpression guard, BoundExpression result)
        : base(syntax)
    {
        Pattern = pattern;
        Guard = guard;
        Result = result;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.SwitchExpressionArm;

    /// <summary>Gets the case pattern expression, or null when this arm is <c>default</c>.</summary>
    public BoundPattern Pattern { get; }

    /// <summary>Gets the optional boolean guard expression (<c>when</c> clause), or null when the arm has no guard.</summary>
    public BoundExpression Guard { get; }

    /// <summary>Gets the result expression.</summary>
    public BoundExpression Result { get; }

    /// <summary>Gets a value indicating whether this is the <c>default</c> arm.</summary>
    public bool IsDefault => Pattern == null;
}
