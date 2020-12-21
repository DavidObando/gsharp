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
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="literalToken">The literal token.</param>
        public LiteralExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken literalToken)
            : this(syntaxTree, literalToken, literalToken.Value)
        {
        }

        /// <summary>
        /// Initializes a new instance of the <see cref="LiteralExpressionSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="literalToken">The literal token.</param>
        /// <param name="value">The literal expression value.</param>
        public LiteralExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken literalToken, object value)
            : base(syntaxTree)
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
