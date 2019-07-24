// <copyright file="BoundAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound assignment expression.
    /// </summary>
    public sealed class BoundAssignmentExpression : BoundExpression
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundAssignmentExpression"/> class.
        /// </summary>
        /// <param name="variable">The variable symbol.</param>
        /// <param name="expression">The expression.</param>
        public BoundAssignmentExpression(VariableSymbol variable, BoundExpression expression)
        {
            Variable = variable;
            Expression = expression;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.AssignmentExpression;

        /// <inheritdoc/>
        public override TypeSymbol Type => Expression.Type;

        /// <summary>
        /// Gets the variable symbol.
        /// </summary>
        public VariableSymbol Variable { get; }

        /// <summary>
        /// Gets the expression.
        /// </summary>
        public BoundExpression Expression { get; }
    }
}
