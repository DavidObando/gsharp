// <copyright file="ForEllipsisStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a for ellipsis statement syntax in the language.
    /// </summary>
    public sealed class ForEllipsisStatementSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ForEllipsisStatementSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="keyword">The for keyword.</param>
        /// <param name="identifier">The variable identifier.</param>
        /// <param name="colonEqualsToken">The colon equals token.</param>
        /// <param name="lowerBound">The lower bound expression.</param>
        /// <param name="ellipsisToken">The ellipsis token.</param>
        /// <param name="upperBound">The upper bound expression.</param>
        /// <param name="body">The body statement.</param>
        public ForEllipsisStatementSyntax(
            SyntaxTree syntaxTree,
            SyntaxToken keyword,
            SyntaxToken identifier,
            SyntaxToken colonEqualsToken,
            ExpressionSyntax lowerBound,
            SyntaxToken ellipsisToken,
            ExpressionSyntax upperBound,
            StatementSyntax body)
            : base(syntaxTree)
        {
            Keyword = keyword;
            Identifier = identifier;
            ColonEqualsToken = colonEqualsToken;
            LowerBound = lowerBound;
            EllipsisToken = ellipsisToken;
            UpperBound = upperBound;
            Body = body;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.ForEllipsisStatement;

        /// <summary>
        /// Gets the for keyword.
        /// </summary>
        public SyntaxToken Keyword { get; }

        /// <summary>
        /// Gets the variable identifier.
        /// </summary>
        public SyntaxToken Identifier { get; }

        /// <summary>
        /// Gets the colon equals statement.
        /// </summary>
        public SyntaxToken ColonEqualsToken { get; }

        /// <summary>
        /// Gets the lower bound expression.
        /// </summary>
        public ExpressionSyntax LowerBound { get; }

        /// <summary>
        /// Gets the ellipsis token.
        /// </summary>
        public SyntaxToken EllipsisToken { get; }

        /// <summary>
        /// Gets the upper bound expression.
        /// </summary>
        public ExpressionSyntax UpperBound { get; }

        /// <summary>
        /// Gets the body statement.
        /// </summary>
        public StatementSyntax Body { get; }
    }
}
