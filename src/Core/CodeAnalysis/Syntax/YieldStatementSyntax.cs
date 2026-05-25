// <copyright file="YieldStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>yield &lt;expr&gt;</c> statement in an iterator function (ADR-0040).
/// </summary>
public sealed class YieldStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="YieldStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="yieldKeyword">The contextual <c>yield</c> keyword token.</param>
    /// <param name="expression">The expression to yield.</param>
    public YieldStatementSyntax(SyntaxTree syntaxTree, SyntaxToken yieldKeyword, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        YieldKeyword = yieldKeyword;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.YieldStatement;

    /// <summary>Gets the contextual <c>yield</c> keyword token.</summary>
    public SyntaxToken YieldKeyword { get; }

    /// <summary>Gets the expression being yielded.</summary>
    public ExpressionSyntax Expression { get; }
}
