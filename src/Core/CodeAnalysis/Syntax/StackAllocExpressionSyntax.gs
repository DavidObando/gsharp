// <copyright file="StackAllocExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0124 / issues #1024, #1057, #1041: a stack-allocation expression in
/// G#-style array grammar `stackalloc [n]T` — the bracketed count first,
/// then the element type. It stack-allocates a contiguous buffer of `n`
/// elements of the blittable element type `T`, emitted as the CIL
/// `localloc` instruction. By default it yields a
/// `System.Span<T>` over the allocated memory (the safe form, no
/// `unsafe` context required); when the declaration target is an
/// unmanaged pointer `*T` (only spellable inside an `unsafe`
/// context, ADR-0122) it yields the raw `T*` pointer instead.
///
/// An optional brace-delimited initializer (`stackalloc [n]T{a, b, …}`)
/// supplies the element values; the count-inferred shape
/// (`stackalloc []T{a, b, …}`, empty brackets) takes the count from the
/// initializer length (issue #1041).
class StackAllocExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:StackAllocExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param stackAllocKeyword The contextual `stackalloc` keyword token.
    /// @param openBracketToken The opening bracket token.
    /// @param countExpression The element-count expression, or `null` for the count-inferred `[]T` shape.
    /// @param closeBracketToken The closing bracket token.
    /// @param elementTypeIdentifier The element type identifier.
    /// @param openBraceToken The opening brace token of the initializer, or `null`.
    /// @param elements The initializer element expressions, or `null` when there is no initializer.
    /// @param closeBraceToken The closing brace token of the initializer, or `null`.
    init(
        syntaxTree SyntaxTree,
        stackAllocKeyword SyntaxToken,
        openBracketToken SyntaxToken,
        countExpression ExpressionSyntax?,
        closeBracketToken SyntaxToken,
        elementTypeIdentifier SyntaxToken,
        openBraceToken SyntaxToken?,
        elements SeparatedSyntaxList[ExpressionSyntax]?,
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        StackAllocKeyword = stackAllocKeyword
        OpenBracketToken = openBracketToken
        CountExpression = countExpression
        CloseBracketToken = closeBracketToken
        ElementTypeIdentifier = elementTypeIdentifier
        OpenBraceToken = openBraceToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.StackAllocExpression

    /// Gets the contextual `stackalloc` keyword token.
    prop StackAllocKeyword SyntaxToken {
        get;
    }

    /// Gets the opening bracket token.
    prop OpenBracketToken SyntaxToken {
        get;
    }

    /// Gets the element-count expression, or `null` for the count-inferred `[]T` shape.
    prop CountExpression ExpressionSyntax? {
        get;
    }

    /// Gets the closing bracket token.
    prop CloseBracketToken SyntaxToken {
        get;
    }

    /// Gets the element type identifier.
    prop ElementTypeIdentifier SyntaxToken {
        get;
    }

    /// Gets the opening brace token of the initializer, or `null`.
    prop OpenBraceToken SyntaxToken? {
        get;
    }

    /// Gets the initializer element expressions, or `null` when there is no initializer.
    prop Elements SeparatedSyntaxList[ExpressionSyntax]? {
        get;
    }

    /// Gets the closing brace token of the initializer, or `null`.
    prop CloseBraceToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether an explicit brace-delimited initializer is present.
    prop HasInitializer bool -> OpenBraceToken != nil

    /// Gets a value indicating whether the count is inferred from the initializer (the `[]T` shape, no
    /// count expression).
    prop IsCountInferred bool -> CountExpression == nil
}
