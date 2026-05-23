// <copyright file="FinallyClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>finally { … }</c> clause attached to a
/// <see cref="TryStatementSyntax"/>.
/// </summary>
public sealed class FinallyClauseSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="FinallyClauseSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="finallyKeyword">The <c>finally</c> keyword.</param>
    /// <param name="body">The cleanup block.</param>
    public FinallyClauseSyntax(SyntaxTree syntaxTree, SyntaxToken finallyKeyword, BlockStatementSyntax body)
        : base(syntaxTree)
    {
        FinallyKeyword = finallyKeyword;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FinallyClause;

    /// <summary>Gets the <c>finally</c> keyword.</summary>
    public SyntaxToken FinallyKeyword { get; }

    /// <summary>Gets the cleanup block.</summary>
    public BlockStatementSyntax Body { get; }
}
