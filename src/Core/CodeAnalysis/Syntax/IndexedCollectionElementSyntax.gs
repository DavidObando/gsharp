// <copyright file="IndexedCollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #479 / ADR-0117: an indexed element of a dictionary collection
/// initializer, e.g. the `["a"] = 1` in
/// `Dictionary[string, int32]{ ["a"] = 1 }`. Lowers to an indexer set
/// `self["a"] = 1` (overwrite semantics, matching C#'s indexed
/// element initializer).
partial class IndexedCollectionElementSyntax : CollectionElementSyntax {
    /// Initializes a new instance of the (cref:IndexedCollectionElementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening `[` token.
    /// @param key The key expression inside the brackets.
    /// @param closeBracketToken The closing `]` token.
    /// @param equalsToken The `=` token.
    /// @param value The value expression.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        key ExpressionSyntax,
        closeBracketToken SyntaxToken,
        equalsToken SyntaxToken,
        value ExpressionSyntax
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        Key = key
        CloseBracketToken = closeBracketToken
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IndexedCollectionElement

    /// Gets the opening `[` token.
    prop OpenBracketToken SyntaxToken {
        get;
    }

    /// Gets the key expression inside the brackets.
    prop Key ExpressionSyntax {
        get;
    }

    /// Gets the closing `]` token.
    prop CloseBracketToken SyntaxToken {
        get;
    }

    /// Gets the `=` token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the value expression.
    prop Value ExpressionSyntax {
        get;
    }
}
