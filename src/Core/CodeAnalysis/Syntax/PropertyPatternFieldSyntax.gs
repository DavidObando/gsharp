// <copyright file="PropertyPatternFieldSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents one field in a property pattern.
partial class PropertyPatternFieldSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:PropertyPatternFieldSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The field identifier.
    /// @param colonToken The colon token.
    /// @param pattern The nested pattern.
    init(syntaxTree SyntaxTree, identifier SyntaxToken, colonToken SyntaxToken, pattern PatternSyntax) : base(
        syntaxTree
    ) {
        Identifier = identifier
        ColonToken = colonToken
        Pattern = pattern
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.PropertyPatternField

    /// Gets the field identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the colon token.
    prop ColonToken SyntaxToken {
        get;
    }

    /// Gets the nested pattern.
    prop Pattern PatternSyntax {
        get;
    }
}
