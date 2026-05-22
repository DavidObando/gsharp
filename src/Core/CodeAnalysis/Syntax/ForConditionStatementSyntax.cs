// <copyright file="ForConditionStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>for cond { body }</c> ("for-as-while") statement.
/// </summary>
public sealed class ForConditionStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ForConditionStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>for</c> keyword.</param>
    /// <param name="condition">The loop condition.</param>
    /// <param name="body">The body statement.</param>
    public ForConditionStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        ExpressionSyntax condition,
        StatementSyntax body)
        : base(syntaxTree)
    {
        Keyword = keyword;
        Condition = condition;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ForConditionStatement;

    /// <summary>
    /// Gets the <c>for</c> keyword.
    /// </summary>
    public SyntaxToken Keyword { get; }

    /// <summary>
    /// Gets the loop condition expression.
    /// </summary>
    public ExpressionSyntax Condition { get; }

    /// <summary>
    /// Gets the body statement.
    /// </summary>
    public StatementSyntax Body { get; }
}
