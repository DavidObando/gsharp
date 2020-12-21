﻿// <copyright file="BreakStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents the break statement syntax in the language.
    /// </summary>
    public class BreakStatementSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BreakStatementSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="keyword">The break keyword.</param>
        public BreakStatementSyntax(SyntaxTree syntaxTree, SyntaxToken keyword)
            : base(syntaxTree)
        {
            Keyword = keyword;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.BreakStatement;

        /// <summary>
        /// Gets the break keyword.
        /// </summary>
        public SyntaxToken Keyword { get; }
    }
}
