// <copyright file="BoundBinaryExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound binary expression.
/// </summary>
public sealed class BoundBinaryExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundBinaryExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="left">The left bound expression.</param>
    /// <param name="op">The bound binary operator.</param>
    /// <param name="right">The right bound expression.</param>
    public BoundBinaryExpression(SyntaxNode syntax, BoundExpression left, BoundBinaryOperator op, BoundExpression right)
        : base(syntax)
    {
        Left = left;
        Op = op;
        Right = right;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.BinaryExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => Op.Type;

    /// <summary>
    /// Gets the left bound expression.
    /// </summary>
    public BoundExpression Left { get; }

    /// <summary>
    /// Gets the bound binary operator.
    /// </summary>
    public BoundBinaryOperator Op { get; }

    /// <summary>
    /// Gets the rught bound expression.
    /// </summary>
    public BoundExpression Right { get; }
}
