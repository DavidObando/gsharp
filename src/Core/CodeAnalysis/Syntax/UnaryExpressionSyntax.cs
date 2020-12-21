// <copyright file="UnaryExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a unary expression in the language.
    /// </summary>
    public class UnaryExpressionSyntax : ExpressionSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="UnaryExpressionSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="operatorToken">The operator.</param>
        /// <param name="operand">The operand.</param>
        public UnaryExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken operatorToken, ExpressionSyntax operand)
            : base(syntaxTree)
        {
            OperatorToken = operatorToken;
            Operand = operand;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.UnaryExpression;

        /// <summary>
        /// Gets the operator.
        /// </summary>
        public SyntaxToken OperatorToken { get; }

        /// <summary>
        /// Gets the operand.
        /// </summary>
        public ExpressionSyntax Operand { get; }
    }
}
