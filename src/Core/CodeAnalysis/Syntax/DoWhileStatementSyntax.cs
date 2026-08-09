// <copyright file="DoWhileStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>do { body } while cond</c> statement (ADR-0070).
/// </summary>
/// <remarks>
/// The body runs unconditionally once before the condition is consulted; the
/// binder lowers the form to a goto-based block (see
/// <c>BindDoWhileStatement</c>). No new <see cref="Binding.BoundNodeKind"/> is
/// introduced — the lowering produces a <see cref="BlockStatementSyntax"/>-
/// shaped bound block on the existing label/goto rails.
/// </remarks>
public sealed class DoWhileStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DoWhileStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="doKeyword">The <c>do</c> keyword.</param>
    /// <param name="body">The body statement.</param>
    /// <param name="whileKeyword">The trailing <c>while</c> keyword.</param>
    /// <param name="condition">The loop condition expression.</param>
    public DoWhileStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken doKeyword,
        StatementSyntax body,
        SyntaxToken whileKeyword,
        ExpressionSyntax condition)
        : base(syntaxTree)
    {
        DoKeyword = doKeyword;
        Body = body;
        WhileKeyword = whileKeyword;
        Condition = condition;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.DoWhileStatement;

    /// <summary>
    /// Gets the leading <c>do</c> keyword.
    /// </summary>
    public SyntaxToken DoKeyword { get; }

    /// <summary>
    /// Gets the body statement.
    /// </summary>
    public StatementSyntax Body { get; }

    /// <summary>
    /// Gets the trailing <c>while</c> keyword.
    /// </summary>
    public SyntaxToken WhileKeyword { get; }

    /// <summary>
    /// Gets the loop condition expression.
    /// </summary>
    public ExpressionSyntax Condition { get; }
}
