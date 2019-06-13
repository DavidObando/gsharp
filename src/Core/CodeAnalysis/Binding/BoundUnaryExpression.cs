// <copyright file="BoundUnaryExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound unary expression.
    /// </summary>
    internal sealed class BoundUnaryExpression : BoundExpression
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundUnaryExpression"/> class.
        /// </summary>
        /// <param name="op">The bound unary operator.</param>
        /// <param name="operand">The bound expression.</param>
        public BoundUnaryExpression(BoundUnaryOperator op, BoundExpression operand)
        {
            Op = op;
            Operand = operand;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.UnaryExpression;

        /// <inheritdoc/>
        public override TypeSymbol Type => Op.Type;

        /// <summary>
        /// Gets the bound unary operator.
        /// </summary>
        public BoundUnaryOperator Op { get; }

        /// <summary>
        /// Gets the bound expression.
        /// </summary>
        public BoundExpression Operand { get; }
    }
}
