// <copyright file="GoStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>go f(args)</c> statement (Phase 5.3 / ADR-0022).
/// The expression must be a call.
/// </summary>
public sealed class GoStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="GoStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="goKeyword">The <c>go</c> keyword token.</param>
    /// <param name="expression">The call expression to start.</param>
    public GoStatementSyntax(SyntaxTree syntaxTree, SyntaxToken goKeyword, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        GoKeyword = goKeyword;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.GoStatement;

    /// <summary>Gets the <c>go</c> keyword token.</summary>
    public SyntaxToken GoKeyword { get; }

    /// <summary>Gets the call expression to launch on a Task.</summary>
    public ExpressionSyntax Expression { get; }
}
