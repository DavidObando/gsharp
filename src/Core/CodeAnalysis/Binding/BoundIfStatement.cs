// <copyright file="BoundIfStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound if statement.
    /// </summary>
    internal sealed class BoundIfStatement : BoundStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundIfStatement"/> class.
        /// </summary>
        /// <param name="condition">The bound if statement condition.</param>
        /// <param name="thenStatement">The then statement.</param>
        /// <param name="elseStatement">The else statement.</param>
        public BoundIfStatement(
            BoundExpression condition,
            BoundStatement thenStatement,
            BoundStatement elseStatement)
        {
            Condition = condition;
            ThenStatement = thenStatement;
            ElseStatement = elseStatement;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.IfStatement;

        /// <summary>
        /// Gets the bound if statement condition.
        /// </summary>
        public BoundExpression Condition { get; }

        /// <summary>
        /// Gets the then statement.
        /// </summary>
        public BoundStatement ThenStatement { get; }

        /// <summary>
        /// Gets the else statement.
        /// </summary>
        public BoundStatement ElseStatement { get; }
    }
}
