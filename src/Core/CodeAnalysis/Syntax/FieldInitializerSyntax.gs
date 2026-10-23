// <copyright file="FieldInitializerSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a single `FieldName: value` element inside a struct composite
/// literal (Phase 3.B.1), or `FieldName = value` in data-struct copy sugar.
/// ADR-0180: also one ordered element of a (cref:StructLiteralExpressionSyntax)'s
/// (cref:StructLiteralExpressionSyntax.Elements) list, alongside
/// (cref:StructLiteralContentElementSyntax).
partial class FieldInitializerSyntax : StructLiteralElementSyntax {
    /// Initializes a new instance of the (cref:FieldInitializerSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param fieldIdentifier The field name.
    /// @param colonToken The field/value separator.
    /// @param value The value expression.
    init(syntaxTree SyntaxTree, fieldIdentifier SyntaxToken, colonToken SyntaxToken, value ExpressionSyntax) : base(
        syntaxTree
    ) {
        FieldIdentifier = fieldIdentifier
        ColonToken = colonToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FieldInitializer

    /// Gets the field identifier.
    prop FieldIdentifier SyntaxToken {
        get;
    }

    /// Gets the field/value separator token.
    prop ColonToken SyntaxToken {
        get;
    }

    /// Gets the value expression.
    prop Value ExpressionSyntax {
        get;
    }
}
