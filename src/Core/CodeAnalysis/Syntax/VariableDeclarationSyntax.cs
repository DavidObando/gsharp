// <copyright file="VariableDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a variable declaration syntax in the language.
    /// </summary>
    public sealed class VariableDeclarationSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="VariableDeclarationSyntax"/> class.
        /// </summary>
        /// <param name="keyword">The var keyword.</param>
        /// <param name="identifier">The variable identifier.</param>
        /// <param name="typeClause">The optional type clause.</param>
        /// <param name="equalsToken">The equals token.</param>
        /// <param name="initializer">The initializer expression.</param>
        public VariableDeclarationSyntax(
            SyntaxToken keyword,
            SyntaxToken identifier,
            TypeClauseSyntax typeClause,
            SyntaxToken equalsToken,
            ExpressionSyntax initializer)
        {
            Keyword = keyword;
            Identifier = identifier;
            TypeClause = typeClause;
            EqualsToken = equalsToken;
            Initializer = initializer;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.VariableDeclaration;

        /// <summary>
        /// Gets the var keyword.
        /// </summary>
        public SyntaxToken Keyword { get; }

        /// <summary>
        /// Gets the variable identifier.
        /// </summary>
        public SyntaxToken Identifier { get; }

        /// <summary>
        /// GEts the optional type clause.
        /// </summary>
        public TypeClauseSyntax TypeClause { get; }

        /// <summary>
        /// Gets the equals token.
        /// </summary>
        public SyntaxToken EqualsToken { get; }

        /// <summary>
        /// Gets the initializer expression.
        /// </summary>
        public ExpressionSyntax Initializer { get; }
    }
}
