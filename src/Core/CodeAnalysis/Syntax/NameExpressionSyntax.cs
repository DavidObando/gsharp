// <copyright file="NameExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a name expression in the language.
    /// </summary>
    public class NameExpressionSyntax : ExpressionSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="NameExpressionSyntax"/> class.
        /// </summary>
        /// <param name="identifierToken">The identifier.</param>
        public NameExpressionSyntax(SyntaxToken identifierToken)
        {
            IdentifierToken = identifierToken;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.NameExpression;

        /// <summary>
        /// Gets the identifier.
        /// </summary>
        public SyntaxToken IdentifierToken { get; }
    }
}
