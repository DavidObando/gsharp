// <copyright file="ForInfiniteStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a for infinite statement syntax in the language.
    /// </summary>
    public sealed class ForInfiniteStatementSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ForInfiniteStatementSyntax"/> class.
        /// </summary>
        /// <param name="keyword">The for keyword.</param>
        /// <param name="body">The body statement.</param>
        public ForInfiniteStatementSyntax(
            SyntaxToken keyword,
            StatementSyntax body)
        {
            Keyword = keyword;
            Body = body;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.ForInfiniteStatement;

        /// <summary>
        /// Gets the for keyword.
        /// </summary>
        public SyntaxToken Keyword { get; }

        /// <summary>
        /// Gets the body statement.
        /// </summary>
        public StatementSyntax Body { get; }
    }
}
