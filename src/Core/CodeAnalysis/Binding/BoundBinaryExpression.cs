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
    /// <param name="isChecked">
    /// When true and <paramref name="op"/> is Sum/Difference/Product, the emitter
    /// and interpreter use overflow-trapping arithmetic (issue #1881): a
    /// `checked(...)` expression or `checked { }` statement puts its arithmetic
    /// in this context; the default (no `checked` context) is unchecked, matching
    /// the C# project default.
    /// </param>
    public BoundBinaryExpression(SyntaxNode syntax, BoundExpression left, BoundBinaryOperator op, BoundExpression right, bool isChecked = false)
        : base(syntax)
    {
        Left = left;
        Op = op;
        Right = right;
        IsChecked = isChecked;
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

    /// <summary>
    /// Gets a value indicating whether this operator runs in a checked /
    /// overflow-trapping context (issue #1881). Only observed for Sum,
    /// Difference, and Product on integral operands.
    /// </summary>
    public bool IsChecked { get; }
}
