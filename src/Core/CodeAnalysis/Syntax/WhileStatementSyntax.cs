#nullable disable

// <copyright file="WhileStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>while cond { body }</c> statement (ADR-0070).
/// </summary>
/// <remarks>
/// Binds identically to <see cref="ForConditionStatementSyntax"/> — the binder
/// lowers both shapes to the same goto/label sequence. Introducing a dedicated
/// syntax node (rather than rewriting at parse time) keeps the syntax-tree
/// pretty-printer faithful to the surface form authors wrote.
/// </remarks>
public sealed class WhileStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="WhileStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="whileKeyword">The <c>while</c> keyword.</param>
    /// <param name="condition">The loop condition expression.</param>
    /// <param name="body">The body statement.</param>
    public WhileStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken whileKeyword,
        ExpressionSyntax condition,
        StatementSyntax body)
        : base(syntaxTree)
    {
        WhileKeyword = whileKeyword;
        Condition = condition;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.WhileStatement;

    /// <summary>
    /// Gets the <c>while</c> keyword.
    /// </summary>
    public SyntaxToken WhileKeyword { get; }

    /// <summary>
    /// Gets the loop condition expression.
    /// </summary>
    public ExpressionSyntax Condition { get; }

    /// <summary>
    /// Gets the body statement.
    /// </summary>
    public StatementSyntax Body { get; }
}
