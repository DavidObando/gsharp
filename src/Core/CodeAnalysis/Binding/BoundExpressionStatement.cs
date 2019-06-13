// <copyright file="BoundExpressionStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound expression statement.
    /// </summary>
    internal sealed class BoundExpressionStatement : BoundStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundExpressionStatement"/> class.
        /// </summary>
        /// <param name="expression">The expression.</param>
        public BoundExpressionStatement(BoundExpression expression)
        {
            Expression = expression;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.ExpressionStatement;

        /// <summary>
        /// Gets the expression.
        /// </summary>
        public BoundExpression Expression { get; }
    }
}
