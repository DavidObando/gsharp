// <copyright file="GlobalStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a global statement in the language.
    /// </summary>
    public class GlobalStatementSyntax : MemberSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="GlobalStatementSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="statement">The statements to include.</param>
        public GlobalStatementSyntax(SyntaxTree syntaxTree, StatementSyntax statement)
            : base(syntaxTree)
        {
            Statement = statement;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.GlobalStatement;

        /// <summary>
        /// Gets the statements included in this global statement.
        /// </summary>
        public StatementSyntax Statement { get; }
    }
}
