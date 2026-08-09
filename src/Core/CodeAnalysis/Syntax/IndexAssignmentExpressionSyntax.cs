// <copyright file="IndexAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an indexed assignment <c>target[index] = value</c>.
/// </summary>
public sealed class IndexAssignmentExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IndexAssignmentExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="targetIdentifier">The identifier being indexed.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="index">The index expression.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    /// <param name="equalsToken">The equals token.</param>
    /// <param name="value">The value expression.</param>
    public IndexAssignmentExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken targetIdentifier,
        SyntaxToken openBracketToken,
        ExpressionSyntax index,
        SyntaxToken closeBracketToken,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        TargetIdentifier = targetIdentifier;
        OpenBracketToken = openBracketToken;
        Index = index;
        CloseBracketToken = closeBracketToken;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IndexAssignmentExpression;

    /// <summary>Gets the identifier being indexed.</summary>
    public SyntaxToken TargetIdentifier { get; }

    /// <summary>Gets the opening bracket token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the index expression.</summary>
    public ExpressionSyntax Index { get; }

    /// <summary>Gets the closing bracket token.</summary>
    public SyntaxToken CloseBracketToken { get; }

    /// <summary>Gets the equals token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
