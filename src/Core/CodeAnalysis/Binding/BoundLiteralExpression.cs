// <copyright file="BoundLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound literal expression.
    /// </summary>
    public sealed class BoundLiteralExpression : BoundExpression
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundLiteralExpression"/> class.
        /// </summary>
        /// <param name="value">The value.</param>
        public BoundLiteralExpression(object value)
        {
            Value = value;

            if (value is bool)
            {
                Type = TypeSymbol.Bool;
            }
            else if (value is int)
            {
                Type = TypeSymbol.Int;
            }
            else if (value is string)
            {
                Type = TypeSymbol.String;
            }
            else
            {
                throw new Exception($"Unexpected literal '{value}' of type {value.GetType()}");
            }
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.LiteralExpression;

        /// <inheritdoc/>
        public override TypeSymbol Type { get; }

        /// <summary>
        /// Gets the value.
        /// </summary>
        public object Value { get; }
    }
}
