// <copyright file="AssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents an assignment expression in the language.
    /// </summary>
    public sealed class AssignmentExpressionSyntax : ExpressionSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="AssignmentExpressionSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="identifierToken">The identifier of the assignment (left side).</param>
        /// <param name="equalsToken">The equals token.</param>
        /// <param name="expression">The expression of the assignment (right side).</param>
        public AssignmentExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken identifierToken, SyntaxToken equalsToken, ExpressionSyntax expression)
            : base(syntaxTree)
        {
            IdentifierToken = identifierToken;
            EqualsToken = equalsToken;
            Expression = expression;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.AssignmentExpression;

        /// <summary>
        /// Gets the identifier of the assignment.
        /// </summary>
        public SyntaxToken IdentifierToken { get; }

        /// <summary>
        /// Gets the equals token.
        /// </summary>
        public SyntaxToken EqualsToken { get; }

        /// <summary>
        /// Gets the expression of the assignment.
        /// </summary>
        public ExpressionSyntax Expression { get; }
    }
}
