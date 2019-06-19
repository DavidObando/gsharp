// <copyright file="BlockStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System.Collections.Immutable;

    /// <summary>
    /// Represents a block statement syntax in the language.
    /// </summary>
    public sealed class BlockStatementSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BlockStatementSyntax"/> class.
        /// </summary>
        /// <param name="openBraceToken">The open brace token.</param>
        /// <param name="statements">The immutable array of statements.</param>
        /// <param name="closeBraceToken">The close brace token.</param>
        public BlockStatementSyntax(
            SyntaxToken openBraceToken,
            ImmutableArray<StatementSyntax> statements,
            SyntaxToken closeBraceToken)
        {
            OpenBraceToken = openBraceToken;
            Statements = statements;
            CloseBraceToken = closeBraceToken;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.BlockStatement;

        /// <summary>
        /// Gets the open brace token.
        /// </summary>
        public SyntaxToken OpenBraceToken { get; }

        /// <summary>
        /// Gets the immutable array of statements.
        /// </summary>
        public ImmutableArray<StatementSyntax> Statements { get; }

        /// <summary>
        /// Gets the close brace token.
        /// </summary>
        public SyntaxToken CloseBraceToken { get; }
    }
}
