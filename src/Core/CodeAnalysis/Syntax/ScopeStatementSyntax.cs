#nullable disable

// <copyright file="ScopeStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>scope { … }</c> structured-concurrency block
/// (Phase 5.7 / ADR-0022). All <c>go</c> statements lexically inside
/// the body register their tasks with the scope; the scope awaits all
/// of them on exit and propagates the first failure.
/// </summary>
public sealed class ScopeStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ScopeStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="scopeKeyword">The <c>scope</c> keyword.</param>
    /// <param name="body">The body block.</param>
    public ScopeStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken scopeKeyword,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        ScopeKeyword = scopeKeyword;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ScopeStatement;

    /// <summary>Gets the <c>scope</c> keyword.</summary>
    public SyntaxToken ScopeKeyword { get; }

    /// <summary>Gets the body block.</summary>
    public BlockStatementSyntax Body { get; }
}
