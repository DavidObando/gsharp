// <copyright file="YieldStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>yield &lt;expr&gt;</c> statement in an iterator function
/// (ADR-0040), or the iteration-terminating <c>yield break</c> statement
/// (issue #3501: C#-aligned early exit from any nesting depth — `break`
/// keeps its loop binding).
/// </summary>
public sealed class YieldStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="YieldStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="yieldKeyword">The contextual <c>yield</c> keyword token.</param>
    /// <param name="expression">The expression to yield, or <see langword="null"/> for <c>yield break</c>.</param>
    /// <param name="breakKeyword">The <c>break</c> keyword token for <c>yield break</c>, or <see langword="null"/>.</param>
    public YieldStatementSyntax(SyntaxTree syntaxTree, SyntaxToken yieldKeyword, ExpressionSyntax? expression, SyntaxToken? breakKeyword = null)
        : base(syntaxTree)
    {
        YieldKeyword = yieldKeyword;
        Expression = expression;
        BreakKeyword = breakKeyword;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.YieldStatement;

    /// <summary>Gets the contextual <c>yield</c> keyword token.</summary>
    public SyntaxToken YieldKeyword { get; }

    /// <summary>Gets the expression being yielded, or <see langword="null"/> for <c>yield break</c>.</summary>
    public ExpressionSyntax? Expression { get; }

    /// <summary>Gets the <c>break</c> keyword for <c>yield break</c>, or <see langword="null"/>.</summary>
    public SyntaxToken? BreakKeyword { get; }
}
