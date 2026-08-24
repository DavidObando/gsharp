// <copyright file="FallthroughStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #3501 A3: the <c>fallthrough</c> statement (Go semantics). Legal
/// only as the last statement of a non-final <c>switch</c> arm body;
/// transfers control to the NEXT arm's body without evaluating that arm's
/// pattern or guard. The binder enforces placement (GS0168 family) — the
/// parser accepts the reserved keyword anywhere a statement can start.
/// </summary>
public sealed class FallthroughStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FallthroughStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>fallthrough</c> keyword token.</param>
    public FallthroughStatementSyntax(SyntaxTree syntaxTree, SyntaxToken keyword)
        : base(syntaxTree)
    {
        Keyword = keyword;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FallthroughStatement;

    /// <summary>Gets the <c>fallthrough</c> keyword token.</summary>
    public SyntaxToken Keyword { get; }
}
