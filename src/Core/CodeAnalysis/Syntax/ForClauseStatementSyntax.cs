#nullable disable

// <copyright file="ForClauseStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a C-style <c>for init; cond; post { body }</c> statement.
/// All three header parts are optional.
/// </summary>
public sealed class ForClauseStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ForClauseStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>for</c> keyword.</param>
    /// <param name="initializer">The optional initializer statement.</param>
    /// <param name="firstSemicolon">The first semicolon separator.</param>
    /// <param name="condition">The optional loop condition.</param>
    /// <param name="secondSemicolon">The second semicolon separator.</param>
    /// <param name="post">The optional post statement.</param>
    /// <param name="body">The body statement.</param>
    public ForClauseStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        StatementSyntax initializer,
        SyntaxToken firstSemicolon,
        ExpressionSyntax condition,
        SyntaxToken secondSemicolon,
        StatementSyntax post,
        StatementSyntax body)
        : base(syntaxTree)
    {
        Keyword = keyword;
        Initializer = initializer;
        FirstSemicolon = firstSemicolon;
        Condition = condition;
        SecondSemicolon = secondSemicolon;
        Post = post;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ForClauseStatement;

    /// <summary>
    /// Gets the <c>for</c> keyword.
    /// </summary>
    public SyntaxToken Keyword { get; }

    /// <summary>
    /// Gets the optional initializer statement.
    /// </summary>
    public StatementSyntax Initializer { get; }

    /// <summary>
    /// Gets the first semicolon separator.
    /// </summary>
    public SyntaxToken FirstSemicolon { get; }

    /// <summary>
    /// Gets the optional loop condition expression.
    /// </summary>
    public ExpressionSyntax Condition { get; }

    /// <summary>
    /// Gets the second semicolon separator.
    /// </summary>
    public SyntaxToken SecondSemicolon { get; }

    /// <summary>
    /// Gets the optional post statement.
    /// </summary>
    public StatementSyntax Post { get; }

    /// <summary>
    /// Gets the body statement.
    /// </summary>
    public StatementSyntax Body { get; }
}
