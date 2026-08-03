// <copyright file="SpreadElementExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an ellipsis spread inside an array or collection initializer,
/// e.g. <c>...items</c> in <c>[]int32{ 0, ...items, 9 }</c>.
/// </summary>
public sealed class SpreadElementExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SpreadElementExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="ellipsisToken">The leading <c>...</c> token.</param>
    /// <param name="expression">The enumerable source expression.</param>
    public SpreadElementExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken ellipsisToken,
        ExpressionSyntax expression)
        : base(syntaxTree)
    {
        EllipsisToken = ellipsisToken;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SpreadElementExpression;

    /// <summary>Gets the leading <c>...</c> token.</summary>
    public SyntaxToken EllipsisToken { get; }

    /// <summary>Gets the enumerable source expression.</summary>
    public ExpressionSyntax Expression { get; }
}
