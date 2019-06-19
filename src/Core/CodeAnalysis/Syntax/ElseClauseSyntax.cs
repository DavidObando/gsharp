// <copyright file="ElseClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents the else clause syntax in the language.
    /// </summary>
    public sealed class ElseClauseSyntax : SyntaxNode
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ElseClauseSyntax"/> class.
        /// </summary>
        /// <param name="elseKeyword">The else keyword.</param>
        /// <param name="elseStatement">The else statement.</param>
        public ElseClauseSyntax(SyntaxToken elseKeyword, StatementSyntax elseStatement)
        {
            ElseKeyword = elseKeyword;
            ElseStatement = elseStatement;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.ElseClause;

        /// <summary>
        /// Gets the else keyword.
        /// </summary>
        public SyntaxToken ElseKeyword { get; }

        /// <summary>
        /// Gets the else statement.
        /// </summary>
        public StatementSyntax ElseStatement { get; }
    }
}
