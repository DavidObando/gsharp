// <copyright file="BoundConversionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound conversion expression.
    /// </summary>
    internal sealed class BoundConversionExpression : BoundExpression
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundConversionExpression"/> class.
        /// </summary>
        /// <param name="type">The type symbol.</param>
        /// <param name="expression">The expression to convert.</param>
        public BoundConversionExpression(TypeSymbol type, BoundExpression expression)
        {
            Type = type;
            Expression = expression;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.ConversionExpression;

        /// <inheritdoc/>
        public override TypeSymbol Type { get; }

        /// <summary>
        /// Gets the expression to convert.
        /// </summary>
        public BoundExpression Expression { get; }
    }
}
