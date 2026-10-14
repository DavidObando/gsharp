// <copyright file="MapEntrySyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a single `key: value` entry inside a map literal
/// `map[K,V]{ … }` (ADR-0104).
class MapEntrySyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:MapEntrySyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param key The key expression.
    /// @param colonToken The colon separator.
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
    override prop Kind SyntaxKind -> SyntaxKind.MapEntry

    /// Gets the key expression.
    prop Key ExpressionSyntax {
        get;
    }

    /// Gets the `:` separator token.
    prop ColonToken SyntaxToken {
        get;
    }

    /// Gets the value expression.
    prop Value ExpressionSyntax {
        get;
    }
}
