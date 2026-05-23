// <copyright file="AwaitExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an <c>await</c> expression (Phase 5.1 / ADR-0023).
/// </summary>
public sealed class AwaitExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="AwaitExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="awaitKeyword">The <c>await</c> keyword token.</param>
    /// <param name="expression">The expression being awaited (must evaluate to a <c>Task</c> / <c>Task[T]</c>).</param>
    public AwaitExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken awaitKeyword, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        AwaitKeyword = awaitKeyword;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AwaitExpression;

    /// <summary>Gets the <c>await</c> keyword token.</summary>
    public SyntaxToken AwaitKeyword { get; }

    /// <summary>Gets the awaited expression.</summary>
    public ExpressionSyntax Expression { get; }
}
