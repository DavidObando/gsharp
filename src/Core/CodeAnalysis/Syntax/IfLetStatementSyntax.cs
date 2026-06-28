#nullable disable

// <copyright file="IfLetStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an <c>if let name = expr [, let n2 = e2]* { body } [else { else }]</c>
/// statement (ADR-0071 / issue #708). The binder lowers this shape into
/// existing if / declaration / block bound nodes; no new bound-node kind is
/// introduced.
/// </summary>
public sealed class IfLetStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IfLetStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="ifKeyword">The <c>if</c> keyword token.</param>
    /// <param name="bindings">The comma-separated list of <c>let</c> bindings.</param>
    /// <param name="thenStatement">The then-block.</param>
    /// <param name="elseClause">The optional else clause.</param>
    public IfLetStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken ifKeyword,
        SeparatedSyntaxList<IfLetBindingClauseSyntax> bindings,
        StatementSyntax thenStatement,
        ElseClauseSyntax elseClause)
        : base(syntaxTree)
    {
        IfKeyword = ifKeyword;
        Bindings = bindings;
        ThenStatement = thenStatement;
        ElseClause = elseClause;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IfLetStatement;

    /// <summary>Gets the <c>if</c> keyword token.</summary>
    public SyntaxToken IfKeyword { get; }

    /// <summary>Gets the comma-separated list of bindings.</summary>
    public SeparatedSyntaxList<IfLetBindingClauseSyntax> Bindings { get; }

    /// <summary>Gets the then-statement (a block).</summary>
    public StatementSyntax ThenStatement { get; }

    /// <summary>Gets the optional else clause; <c>null</c> when absent.</summary>
    public ElseClauseSyntax ElseClause { get; }
}
