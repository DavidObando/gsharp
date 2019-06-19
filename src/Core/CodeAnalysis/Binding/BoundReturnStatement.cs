// <copyright file="BoundReturnStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound return statement.
    /// </summary>
    internal sealed class BoundReturnStatement : BoundStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundReturnStatement"/> class.
        /// </summary>
        /// <param name="expression">The expression to return.</param>
        public BoundReturnStatement(BoundExpression expression)
        {
            Expression = expression;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.ReturnStatement;

        /// <summary>
        /// Gets the expression to return.
        /// </summary>
        public BoundExpression Expression { get; }
    }
}
