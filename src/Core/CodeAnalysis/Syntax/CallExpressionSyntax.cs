// <copyright file="CallExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a call expression syntax in the language.
    /// </summary>
    public sealed class CallExpressionSyntax : ExpressionSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="CallExpressionSyntax"/> class.
        /// </summary>
        /// <param name="identifier">The identifier.</param>
        /// <param name="openParenthesisToken">The open parenthesis token.</param>
        /// <param name="arguments">The arguments.</param>
        /// <param name="closeParenthesisToken">The close parenthesis token.</param>
        public CallExpressionSyntax(
            SyntaxToken identifier,
            SyntaxToken openParenthesisToken,
            SeparatedSyntaxList<ExpressionSyntax> arguments,
            SyntaxToken closeParenthesisToken)
        {
            Identifier = identifier;
            OpenParenthesisToken = openParenthesisToken;
            Arguments = arguments;
            CloseParenthesisToken = closeParenthesisToken;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.CallExpression;

        /// <summary>
        /// Gets the identifier.
        /// </summary>
        public SyntaxToken Identifier { get; }

        /// <summary>
        /// Gets the open parenthesis token.
        /// </summary>
        public SyntaxToken OpenParenthesisToken { get; }

        /// <summary>
        /// Gets the arguments.
        /// </summary>
        public SeparatedSyntaxList<ExpressionSyntax> Arguments { get; }

        /// <summary>
        /// Gets the close parenthesis token.
        /// </summary>
        public SyntaxToken CloseParenthesisToken { get; }
    }
}
