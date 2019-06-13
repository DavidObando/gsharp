// <copyright file="ReturnStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents the return statement syntax in the language.
    /// </summary>
    public sealed class ReturnStatementSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ReturnStatementSyntax"/> class.
        /// </summary>
        /// <param name="returnKeyword">The return keyword.</param>
        /// <param name="expression">The expression.</param>
        public ReturnStatementSyntax(SyntaxToken returnKeyword, ExpressionSyntax expression)
        {
            ReturnKeyword = returnKeyword;
            Expression = expression;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.ReturnStatement;

        /// <summary>
        /// Gets the return keyword.
        /// </summary>
        public SyntaxToken ReturnKeyword { get; }

        /// <summary>
        /// Gets the expression.
        /// </summary>
        public ExpressionSyntax Expression { get; }
    }
}
