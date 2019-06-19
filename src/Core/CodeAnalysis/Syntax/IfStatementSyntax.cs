// <copyright file="IfStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents an if statement in the language.
    /// </summary>
    public sealed class IfStatementSyntax : StatementSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="IfStatementSyntax"/> class.
        /// </summary>
        /// <param name="ifKeyword">The if keyword.</param>
        /// <param name="condition">The condition expression.</param>
        /// <param name="thenStatement">The then statement.</param>
        /// <param name="elseClause">The else clause.</param>
        public IfStatementSyntax(
            SyntaxToken ifKeyword,
            ExpressionSyntax condition,
            StatementSyntax thenStatement,
            ElseClauseSyntax elseClause)
        {
            IfKeyword = ifKeyword;
            Condition = condition;
            ThenStatement = thenStatement;
            ElseClause = elseClause;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.IfStatement;

        /// <summary>
        /// Gets the if keyword.
        /// </summary>
        public SyntaxToken IfKeyword { get; }

        /// <summary>
        /// Gets the condition expression.
        /// </summary>
        public ExpressionSyntax Condition { get; }

        /// <summary>
        /// Gets the then statement.
        /// </summary>
        public StatementSyntax ThenStatement { get; }

        /// <summary>
        /// Gets the else clause.
        /// </summary>
        public ElseClauseSyntax ElseClause { get; }
    }
}
