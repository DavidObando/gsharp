// <copyright file="LiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a literal expression in the language.
    /// </summary>
    public sealed class LiteralExpressionSyntax : ExpressionSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="LiteralExpressionSyntax"/> class.
        /// </summary>
        /// <param name="literalToken">The literal token.</param>
        public LiteralExpressionSyntax(SyntaxToken literalToken)
            : this(literalToken, literalToken.Value)
        {
        }

        /// <summary>
        /// Initializes a new instance of the <see cref="LiteralExpressionSyntax"/> class.
        /// </summary>
        /// <param name="literalToken">The literal token.</param>
        /// <param name="value">The literal expression value.</param>
        public LiteralExpressionSyntax(SyntaxToken literalToken, object value)
        {
            LiteralToken = literalToken;
            Value = value;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.LiteralExpression;

        /// <summary>
        /// Gets the literal token.
        /// </summary>
        public SyntaxToken LiteralToken { get; }

        /// <summary>
        /// Gets the literal value.
        /// </summary>
        public object Value { get; }
    }
}
