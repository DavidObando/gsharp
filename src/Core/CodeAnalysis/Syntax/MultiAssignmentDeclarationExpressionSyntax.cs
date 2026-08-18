// <copyright file="MultiAssignmentDeclarationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// A fresh local target inside a multi-assignment, for example
/// <c>existing, let fresh = Pair()</c>.
/// </summary>
public sealed class MultiAssignmentDeclarationExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="MultiAssignmentDeclarationExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>let</c> or <c>var</c> keyword.</param>
    /// <param name="identifier">The declared local identifier.</param>
    public MultiAssignmentDeclarationExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        SyntaxToken identifier)
        : base(syntaxTree)
    {
        Keyword = keyword;
        Identifier = identifier;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.MultiAssignmentDeclarationExpression;

    /// <summary>Gets the <c>let</c> or <c>var</c> keyword.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the declared local identifier.</summary>
    public SyntaxToken Identifier { get; }
}
