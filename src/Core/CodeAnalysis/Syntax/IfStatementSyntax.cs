// <copyright file="IfStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an if statement in the language.
/// </summary>
public sealed class IfStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IfStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="ifKeyword">The if keyword.</param>
    /// <param name="condition">The condition expression.</param>
    /// <param name="thenStatement">The then statement.</param>
    /// <param name="elseClause">The else clause.</param>
    public IfStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken ifKeyword,
        ExpressionSyntax condition,
        StatementSyntax thenStatement,
        ElseClauseSyntax elseClause)
        : this(syntaxTree, ifKeyword, initializer: null, semicolon: null, condition, thenStatement, elseClause)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="IfStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="ifKeyword">The if keyword.</param>
    /// <param name="initializer">The optional initializer simple statement (the `init` in `if init; cond`).</param>
    /// <param name="semicolon">The semicolon separating the initializer from the condition.</param>
    /// <param name="condition">The condition expression.</param>
    /// <param name="thenStatement">The then statement.</param>
    /// <param name="elseClause">The else clause.</param>
    public IfStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken ifKeyword,
        StatementSyntax initializer,
        SyntaxToken semicolon,
        ExpressionSyntax condition,
        StatementSyntax thenStatement,
        ElseClauseSyntax elseClause)
        : base(syntaxTree)
    {
        IfKeyword = ifKeyword;
        Initializer = initializer;
        Semicolon = semicolon;
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
    /// Gets the optional initializer simple statement (the <c>init</c>
    /// in <c>if init; cond</c>). May be <c>null</c>.
    /// </summary>
    public StatementSyntax Initializer { get; }

    /// <summary>
    /// Gets the semicolon separating the initializer from the condition,
    /// or <c>null</c> when there is no initializer.
    /// </summary>
    public SyntaxToken Semicolon { get; }

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
