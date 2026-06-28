#nullable disable

// <copyright file="ArrayCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an array creation expression <c>[N]T{e1, e2, …}</c>.
/// <para>
/// Issue #1272: also represents the runtime/zero-initialised allocation form
/// <c>[n]T</c> (and the equivalent empty-initializer spelling <c>[n]T{}</c>),
/// where <c>n</c> is an arbitrary length expression and there are no element
/// initialisers. That form carries its length via <see cref="LengthExpression"/>
/// instead of the literal <see cref="LengthToken"/>, and yields a
/// zero-initialised slice <c>[]T</c> of length <c>n</c>.
/// </para>
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

    /// <summary>
    /// Initializes a new instance of the <see cref="ArrayCreationExpressionSyntax"/> class
    /// whose element type is itself a (non-identifier) nested type clause — enabling
    /// jagged-array literals such as <c>[][]int32{ []int32{1}, []int32{2, 3} }</c> (issue #1046).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="lengthToken">The literal length token.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    /// <param name="elementTypeClause">The nested element type clause.</param>
    /// <param name="openBraceToken">The opening brace token.</param>
    /// <param name="elements">The element initialisers.</param>
    /// <param name="closeBraceToken">The closing brace token.</param>
    public ArrayCreationExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SyntaxToken lengthToken,
        SyntaxToken closeBracketToken,
        TypeClauseSyntax elementTypeClause,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<ExpressionSyntax> elements,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        LengthToken = lengthToken;
        CloseBracketToken = closeBracketToken;
        ElementTypeClause = elementTypeClause;
        OpenBraceToken = openBraceToken;
        Elements = elements;
        CloseBraceToken = closeBraceToken;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ArrayCreationExpressionSyntax"/> class
    /// for the runtime/zero-initialised allocation form <c>[n]T</c> (issue #1272),
    /// whose length is an arbitrary <paramref name="lengthExpression"/> and whose
    /// element type is a plain identifier. There are no element initialisers; an
    /// optional empty brace pair (<c>[n]T{}</c>) may be present.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="lengthExpression">The runtime length expression.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    /// <param name="elementTypeIdentifier">The element type identifier.</param>
    /// <param name="openBraceToken">The opening brace token, or <see langword="null"/> when there is no brace.</param>
    /// <param name="elements">The (empty) element initialisers, or <see langword="null"/> when there is no brace.</param>
    /// <param name="closeBraceToken">The closing brace token, or <see langword="null"/> when there is no brace.</param>
    public ArrayCreationExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        ExpressionSyntax lengthExpression,
        SyntaxToken closeBracketToken,
        SyntaxToken elementTypeIdentifier,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<ExpressionSyntax> elements,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        LengthExpression = lengthExpression;
        CloseBracketToken = closeBracketToken;
        ElementTypeIdentifier = elementTypeIdentifier;
        OpenBraceToken = openBraceToken;
        Elements = elements;
        CloseBraceToken = closeBraceToken;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ArrayCreationExpressionSyntax"/> class
    /// for the runtime/zero-initialised allocation form <c>[n]T</c> (issue #1272)
    /// whose element type is itself a (non-identifier) nested type clause, e.g.
    /// <c>[n][]int32</c> (issue #1046 element shape). There are no element
    /// initialisers; an optional empty brace pair may be present.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="lengthExpression">The runtime length expression.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    /// <param name="elementTypeClause">The nested element type clause.</param>
    /// <param name="openBraceToken">The opening brace token, or <see langword="null"/> when there is no brace.</param>
    /// <param name="elements">The (empty) element initialisers, or <see langword="null"/> when there is no brace.</param>
    /// <param name="closeBraceToken">The closing brace token, or <see langword="null"/> when there is no brace.</param>
    public ArrayCreationExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        ExpressionSyntax lengthExpression,
        SyntaxToken closeBracketToken,
        TypeClauseSyntax elementTypeClause,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<ExpressionSyntax> elements,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        LengthExpression = lengthExpression;
        CloseBracketToken = closeBracketToken;
        ElementTypeClause = elementTypeClause;
        OpenBraceToken = openBraceToken;
        Elements = elements;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ArrayCreationExpression;

    /// <summary>Gets the opening bracket token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the literal length token, or <c>null</c> for the slice form (<c>[]T{…}</c>) or the runtime-length form (which carries <see cref="LengthExpression"/>).</summary>
    public SyntaxToken LengthToken { get; }

    /// <summary>Gets the runtime length expression for the zero-initialised allocation form <c>[n]T</c> (issue #1272), or <c>null</c> when the length is a literal (see <see cref="LengthToken"/>) or absent (slice form).</summary>
    public ExpressionSyntax LengthExpression { get; }

    /// <summary>Gets the closing bracket token.</summary>
    public SyntaxToken CloseBracketToken { get; }

    /// <summary>Gets the element type identifier, or <c>null</c> when the element is a nested type clause (see <see cref="ElementTypeClause"/>).</summary>
    public SyntaxToken ElementTypeIdentifier { get; }

    /// <summary>Gets the nested element type clause for a jagged-array literal (issue #1046), or <c>null</c> when the element is a plain identifier carried via <see cref="ElementTypeIdentifier"/>.</summary>
    public TypeClauseSyntax ElementTypeClause { get; }

    /// <summary>Gets a value indicating whether this literal's element type is a nested type clause rather than a plain identifier (issue #1046).</summary>
    public bool HasNestedElementTypeClause => ElementTypeClause != null;

    /// <summary>Gets the opening brace token.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the element initialisers.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> Elements { get; }

    /// <summary>Gets the closing brace token.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>Gets a value indicating whether an explicit brace-delimited initializer is present.</summary>
    public bool HasInitializer => OpenBraceToken != null;

    /// <summary>Gets a value indicating whether this is the runtime/zero-initialised allocation form <c>[n]T</c> (issue #1272), carrying its length via <see cref="LengthExpression"/>.</summary>
    public bool IsRuntimeLengthAllocation => LengthExpression != null;
}
