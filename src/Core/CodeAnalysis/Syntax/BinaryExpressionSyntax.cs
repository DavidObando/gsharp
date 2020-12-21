// <copyright file="BinaryExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a binary expression in the language.
    /// </summary>
    public class BinaryExpressionSyntax : ExpressionSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BinaryExpressionSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="left">The left side of the binary expression.</param>
        /// <param name="operatorToken">The operator.</param>
        /// <param name="right">The right side of the binary expression.</param>
        public BinaryExpressionSyntax(SyntaxTree syntaxTree, ExpressionSyntax left, SyntaxToken operatorToken, ExpressionSyntax right)
            : base(syntaxTree)
        {
            Left = left;
            OperatorToken = operatorToken;
            Right = right;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.BinaryExpression;

        /// <summary>
        /// Gets the left side of the binary expression.
        /// </summary>
        public ExpressionSyntax Left { get; }

        /// <summary>
        /// Gets the operator.
        /// </summary>
        public SyntaxToken OperatorToken { get; }

        /// <summary>
        /// Gets the right side of the binary expression.
        /// </summary>
        public ExpressionSyntax Right { get; }
    }
}
