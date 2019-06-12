// <copyright file="ParenthesizedExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a parenthesized expression in the language.
    /// </summary>
    public sealed class ParenthesizedExpressionSyntax : ExpressionSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ParenthesizedExpressionSyntax"/> class.
        /// </summary>
        /// <param name="openParenthesisToken">The open parenthesys token.</param>
        /// <param name="expression">The expression.</param>
        /// <param name="closeParenthesisToken">The close parenthesys token.</param>
        public ParenthesizedExpressionSyntax(SyntaxToken openParenthesisToken, ExpressionSyntax expression, SyntaxToken closeParenthesisToken)
        {
            OpenParenthesisToken = openParenthesisToken;
            Expression = expression;
            CloseParenthesisToken = closeParenthesisToken;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.ParenthesizedExpression;

        /// <summary>
        /// Gets the open parenthesis token.
        /// </summary>
        public SyntaxToken OpenParenthesisToken { get; }

        /// <summary>
        /// Gets the expression.
        /// </summary>
        public ExpressionSyntax Expression { get; }

        /// <summary>
        /// Gets the close parenthesis token.
        /// </summary>
        public SyntaxToken CloseParenthesisToken { get; }
    }
}
