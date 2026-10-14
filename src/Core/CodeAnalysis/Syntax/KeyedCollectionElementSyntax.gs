// <copyright file="KeyedCollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #479 / ADR-0117: a key/value element of a dictionary collection
/// initializer, e.g. the `"a": 1` in
/// `Dictionary[string, int32]{"a": 1, "b": 2}`. Lowers to an
/// `Add(key, value)` call on the constructed dictionary.
class KeyedCollectionElementSyntax : CollectionElementSyntax {
    /// Initializes a new instance of the (cref:KeyedCollectionElementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param key The key expression.
    /// @param colonToken The `:` token separating key and value.
    /// @param value The value expression.
    init(syntaxTree SyntaxTree, key ExpressionSyntax, colonToken SyntaxToken, value ExpressionSyntax) : base(
        syntaxTree
    ) {
        Key = key
        ColonToken = colonToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.KeyedCollectionElement

    /// Gets the key expression.
    prop Key ExpressionSyntax {
        get;
    }

    /// Gets the `:` token separating key and value.
    prop ColonToken SyntaxToken {
        get;
    }

    /// Gets the value expression.
    prop Value ExpressionSyntax {
        get;
    }
}
