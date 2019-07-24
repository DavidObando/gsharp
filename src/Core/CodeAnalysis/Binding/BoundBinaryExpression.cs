// <copyright file="BoundBinaryExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound binary expression.
    /// </summary>
    public sealed class BoundBinaryExpression : BoundExpression
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundBinaryExpression"/> class.
        /// </summary>
        /// <param name="left">The left bound expression.</param>
        /// <param name="op">The bound binary operator.</param>
        /// <param name="right">The right bound expression.</param>
        public BoundBinaryExpression(BoundExpression left, BoundBinaryOperator op, BoundExpression right)
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
}
