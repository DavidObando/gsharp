#nullable disable

// <copyright file="BlockExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #669: a block-with-trailing-expression of the form
/// <c>{ stmt1; stmt2; expr }</c>. The trailing expression (if present)
/// is the value produced by the block. When there is no trailing expression
/// the block is statement-only and is only legal in statement position.
/// </summary>
public sealed class BlockExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BlockExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBraceToken">The opening <c>{</c> token.</param>
    /// <param name="statements">The prefix statements (all but the trailing expression).</param>
    /// <param name="expression">The trailing expression that yields the block's value (may be null for statement-only blocks).</param>
    /// <param name="closeBraceToken">The closing <c>}</c> token.</param>
    public BlockExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBraceToken,
        ImmutableArray<StatementSyntax> statements,
        ExpressionSyntax expression,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        OpenBraceToken = openBraceToken;
        Statements = statements;
        Expression = expression;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.BlockExpression;

    /// <summary>Gets the opening <c>{</c> token.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the prefix statements.</summary>
    public ImmutableArray<StatementSyntax> Statements { get; }

    /// <summary>
    /// Gets the trailing expression. May be null for statement-only blocks
    /// (in which case the surrounding if-expression is only legal in statement
    /// position, which the binder enforces).
    /// </summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the closing <c>}</c> token.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
