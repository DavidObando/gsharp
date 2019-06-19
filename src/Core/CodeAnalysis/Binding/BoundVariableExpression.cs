// <copyright file="BoundVariableExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound variable expression.
    /// </summary>
    internal sealed class BoundVariableExpression : BoundExpression
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundVariableExpression"/> class.
        /// </summary>
        /// <param name="variable">The variable symbol.</param>
        public BoundVariableExpression(VariableSymbol variable)
        {
            Variable = variable;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.VariableExpression;

        /// <inheritdoc/>
        public override TypeSymbol Type => Variable.Type;

        /// <summary>
        /// Gets the variable symbol.
        /// </summary>
        public VariableSymbol Variable { get; }
    }
}
