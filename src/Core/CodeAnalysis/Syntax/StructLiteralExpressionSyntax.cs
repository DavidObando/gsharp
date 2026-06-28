#nullable disable

// <copyright file="StructLiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a struct composite literal: <c>Point{X: 1, Y: 2}</c> (Phase 3.B.1).
/// </summary>
public sealed class StructLiteralExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StructLiteralExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="typeIdentifier">The struct type identifier.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="initializers">The field initializers.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructLiteralExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken typeIdentifier,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<FieldInitializerSyntax> initializers,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        TypeIdentifier = typeIdentifier;
        OpenBraceToken = openBraceToken;
        Initializers = initializers;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.StructLiteralExpression;

    /// <summary>Gets the struct type identifier.</summary>
    public SyntaxToken TypeIdentifier { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the field initializers.</summary>
    public SeparatedSyntaxList<FieldInitializerSyntax> Initializers { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>Gets or sets the optional type-argument list (Phase 4.3 / ADR-0020), e.g. <c>Result[int, string]{...}</c>. <c>null</c> for non-generic literals or for literals whose type arguments are to be inferred.</summary>
    public TypeArgumentListSyntax TypeArgumentList { get; set; }
}
