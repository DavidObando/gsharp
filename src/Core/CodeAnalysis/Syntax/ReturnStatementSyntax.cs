#nullable disable

// <copyright file="ReturnStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the return statement syntax in the language.
/// </summary>
public sealed class ReturnStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ReturnStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="returnKeyword">The return keyword.</param>
    /// <param name="expression">The expression.</param>
    public ReturnStatementSyntax(SyntaxTree syntaxTree, SyntaxToken returnKeyword, ExpressionSyntax expression)
        : this(syntaxTree, returnKeyword, refKeyword: null, expression)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ReturnStatementSyntax"/> class with an optional
    /// <c>ref</c> contextual modifier (issue #490 — <c>return ref &lt;lvalue&gt;</c>).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="returnKeyword">The return keyword.</param>
    /// <param name="refKeyword">The optional <c>ref</c> contextual modifier; <c>null</c> when absent.</param>
    /// <param name="expression">The expression.</param>
    public ReturnStatementSyntax(SyntaxTree syntaxTree, SyntaxToken returnKeyword, SyntaxToken refKeyword, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        ReturnKeyword = returnKeyword;
        RefKeyword = refKeyword;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ReturnStatement;

    /// <summary>
    /// Gets the return keyword.
    /// </summary>
    public SyntaxToken ReturnKeyword { get; }

    /// <summary>
    /// Gets the optional <c>ref</c> contextual modifier immediately following the
    /// <c>return</c> keyword (issue #490 / ADR-0060 follow-up). Non-null when the source
    /// is <c>return ref &lt;lvalue&gt;</c>.
    /// </summary>
    public SyntaxToken RefKeyword { get; }

    /// <summary>Gets a value indicating whether this is a <c>return ref</c> statement (issue #490).</summary>
    public bool IsRefReturn => RefKeyword != null;

    /// <summary>
    /// Gets the expression.
    /// </summary>
    public ExpressionSyntax Expression { get; }
}
