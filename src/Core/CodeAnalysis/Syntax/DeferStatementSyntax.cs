// <copyright file="DeferStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>defer f(args)</c> statement (Phase 7.1 / ADR-0030).
/// The expression must be a call.
/// </summary>
public sealed class DeferStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="DeferStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="deferKeyword">The <c>defer</c> keyword token.</param>
    /// <param name="expression">The call expression to run when the enclosing block exits.</param>
    public DeferStatementSyntax(SyntaxTree syntaxTree, SyntaxToken deferKeyword, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        DeferKeyword = deferKeyword;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.DeferStatement;

    /// <summary>Gets the <c>defer</c> keyword token.</summary>
    public SyntaxToken DeferKeyword { get; }

    /// <summary>Gets the call expression to run when the enclosing block exits.</summary>
    public ExpressionSyntax Expression { get; }
}
