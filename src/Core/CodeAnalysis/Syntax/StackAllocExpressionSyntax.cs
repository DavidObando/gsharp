#nullable disable

// <copyright file="StackAllocExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0124 / issues #1024, #1057, #1041: a stack-allocation expression in
/// G#-style array grammar <c>stackalloc [n]T</c> — the bracketed count first,
/// then the element type. It stack-allocates a contiguous buffer of <c>n</c>
/// elements of the blittable element type <c>T</c>, emitted as the CIL
/// <c>localloc</c> instruction. By default it yields a
/// <c>System.Span&lt;T&gt;</c> over the allocated memory (the safe form, no
/// <c>unsafe</c> context required); when the declaration target is an
/// unmanaged pointer <c>*T</c> (only spellable inside an <c>unsafe</c>
/// context, ADR-0122) it yields the raw <c>T*</c> pointer instead.
/// <para>
/// An optional brace-delimited initializer (<c>stackalloc [n]T{a, b, …}</c>)
/// supplies the element values; the count-inferred shape
/// (<c>stackalloc []T{a, b, …}</c>, empty brackets) takes the count from the
/// initializer length (issue #1041).
/// </para>
/// </summary>
public sealed class StackAllocExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StackAllocExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="stackAllocKeyword">The contextual <c>stackalloc</c> keyword token.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="countExpression">The element-count expression, or <see langword="null"/> for the count-inferred <c>[]T</c> shape.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    /// <param name="elementTypeIdentifier">The element type identifier.</param>
    /// <param name="openBraceToken">The opening brace token of the initializer, or <see langword="null"/>.</param>
    /// <param name="elements">The initializer element expressions, or <see langword="null"/> when there is no initializer.</param>
    /// <param name="closeBraceToken">The closing brace token of the initializer, or <see langword="null"/>.</param>
    public StackAllocExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken stackAllocKeyword,
        SyntaxToken openBracketToken,
        ExpressionSyntax countExpression,
        SyntaxToken closeBracketToken,
        SyntaxToken elementTypeIdentifier,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<ExpressionSyntax> elements,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        StackAllocKeyword = stackAllocKeyword;
        OpenBracketToken = openBracketToken;
        CountExpression = countExpression;
        CloseBracketToken = closeBracketToken;
        ElementTypeIdentifier = elementTypeIdentifier;
        OpenBraceToken = openBraceToken;
        Elements = elements;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.StackAllocExpression;

    /// <summary>Gets the contextual <c>stackalloc</c> keyword token.</summary>
    public SyntaxToken StackAllocKeyword { get; }

    /// <summary>Gets the opening bracket token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the element-count expression, or <see langword="null"/> for the count-inferred <c>[]T</c> shape.</summary>
    public ExpressionSyntax CountExpression { get; }

    /// <summary>Gets the closing bracket token.</summary>
    public SyntaxToken CloseBracketToken { get; }

    /// <summary>Gets the element type identifier.</summary>
    public SyntaxToken ElementTypeIdentifier { get; }

    /// <summary>Gets the opening brace token of the initializer, or <see langword="null"/>.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the initializer element expressions, or <see langword="null"/> when there is no initializer.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> Elements { get; }

    /// <summary>Gets the closing brace token of the initializer, or <see langword="null"/>.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>Gets a value indicating whether an explicit brace-delimited initializer is present.</summary>
    public bool HasInitializer => OpenBraceToken != null;

    /// <summary>Gets a value indicating whether the count is inferred from the initializer (the <c>[]T</c> shape, no count expression).</summary>
    public bool IsCountInferred => CountExpression == null;
}
