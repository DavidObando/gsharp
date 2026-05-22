// <copyright file="IndexExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an index expression <c>target[index]</c>.
/// </summary>
public sealed class IndexExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IndexExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The expression being indexed.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="index">The index expression.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    public IndexExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax target,
        SyntaxToken openBracketToken,
        ExpressionSyntax index,
        SyntaxToken closeBracketToken)
        : base(syntaxTree)
    {
        Target = target;
        OpenBracketToken = openBracketToken;
        Index = index;
        CloseBracketToken = closeBracketToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IndexExpression;

    /// <summary>Gets the expression being indexed.</summary>
    public ExpressionSyntax Target { get; }

    /// <summary>Gets the opening bracket token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the index expression.</summary>
    public ExpressionSyntax Index { get; }

    /// <summary>Gets the closing bracket token.</summary>
    public SyntaxToken CloseBracketToken { get; }
}
