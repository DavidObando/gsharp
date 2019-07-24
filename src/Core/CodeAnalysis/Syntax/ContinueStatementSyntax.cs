// <copyright file="ContinueStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents the continue statement in the language.
    /// </summary>
    public class ContinueStatementSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ContinueStatementSyntax"/> class.
        /// </summary>
        /// <param name="keyword">The continue keyword.</param>
        public ContinueStatementSyntax(SyntaxToken keyword)
        {
            Keyword = keyword;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.ContinueStatement;

        /// <summary>
        /// Gets the continue keyword.
        /// </summary>
        public SyntaxToken Keyword { get; }
    }
}
