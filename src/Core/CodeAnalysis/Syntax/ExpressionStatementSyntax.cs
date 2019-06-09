// <copyright file="ExpressionStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents an expression statement in the language.
    /// </summary>
    public class ExpressionStatementSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ExpressionStatementSyntax"/> class.
        /// </summary>
        /// <param name="expression">The expression.</param>
        public ExpressionStatementSyntax(ExpressionSyntax expression)
        {
            Expression = expression;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.ExpressionStatement;

        /// <summary>
        /// Gets the expression.
        /// </summary>
        public ExpressionSyntax Expression { get; }
    }
}
