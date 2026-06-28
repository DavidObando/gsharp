#nullable disable

// <copyright file="TupleLiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a tuple literal expression <c>(e1, e2, ...)</c> (Phase 4.5).
/// </summary>
public sealed class TupleLiteralExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="TupleLiteralExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openParenToken">The opening <c>(</c>.</param>
    /// <param name="elements">The comma-separated tuple element expressions.</param>
    /// <param name="closeParenToken">The closing <c>)</c>.</param>
    public TupleLiteralExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<ExpressionSyntax> elements,
        SyntaxToken closeParenToken)
        : base(syntaxTree)
    {
        OpenParenToken = openParenToken;
        Elements = elements;
        CloseParenToken = closeParenToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TupleLiteralExpression;

    /// <summary>Gets the opening <c>(</c> token.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the tuple element expressions.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> Elements { get; }

    /// <summary>Gets the closing <c>)</c> token.</summary>
    public SyntaxToken CloseParenToken { get; }
}
