// <copyright file="ArrayCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an array creation expression <c>[N]T{e1, e2, …}</c>.
/// </summary>
public sealed class ArrayCreationExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ArrayCreationExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="lengthToken">The literal length token.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    /// <param name="elementTypeIdentifier">The element type identifier.</param>
    /// <param name="openBraceToken">The opening brace token.</param>
    /// <param name="elements">The element initialisers.</param>
    /// <param name="closeBraceToken">The closing brace token.</param>
    public ArrayCreationExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SyntaxToken lengthToken,
        SyntaxToken closeBracketToken,
        SyntaxToken elementTypeIdentifier,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<ExpressionSyntax> elements,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        LengthToken = lengthToken;
        CloseBracketToken = closeBracketToken;
        ElementTypeIdentifier = elementTypeIdentifier;
        OpenBraceToken = openBraceToken;
        Elements = elements;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ArrayCreationExpression;

    /// <summary>Gets the opening bracket token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the literal length token.</summary>
    public SyntaxToken LengthToken { get; }

    /// <summary>Gets the closing bracket token.</summary>
    public SyntaxToken CloseBracketToken { get; }

    /// <summary>Gets the element type identifier.</summary>
    public SyntaxToken ElementTypeIdentifier { get; }

    /// <summary>Gets the opening brace token.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the element initialisers.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> Elements { get; }

    /// <summary>Gets the closing brace token.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
