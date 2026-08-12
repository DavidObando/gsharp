// <copyright file="WhileLetStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>while let name = expr [, let n2 = e2]* { body }</c>
/// statement (ADR-0163 / issue #3352).
/// </summary>
/// <remarks>
/// Each initializer is re-evaluated before every iteration. The bindings are
/// visible only inside <see cref="Body"/> and are observed there at their
/// underlying non-null types.
/// </remarks>
public sealed class WhileLetStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="WhileLetStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="whileKeyword">The <c>while</c> keyword token.</param>
    /// <param name="bindings">The comma-separated <c>let</c> bindings.</param>
    /// <param name="body">The loop body.</param>
    public WhileLetStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken whileKeyword,
        SeparatedSyntaxList<IfLetBindingClauseSyntax> bindings,
        StatementSyntax body)
        : base(syntaxTree)
    {
        WhileKeyword = whileKeyword;
        Bindings = bindings;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.WhileLetStatement;

    /// <summary>Gets the <c>while</c> keyword token.</summary>
    public SyntaxToken WhileKeyword { get; }

    /// <summary>Gets the comma-separated binding list.</summary>
    public SeparatedSyntaxList<IfLetBindingClauseSyntax> Bindings { get; }

    /// <summary>Gets the loop body.</summary>
    public StatementSyntax Body { get; }
}
