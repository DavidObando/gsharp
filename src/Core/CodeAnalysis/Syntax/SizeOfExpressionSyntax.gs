// <copyright file="SizeOfExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the built-in `sizeof(T)` operator (issue #1336).
/// `sizeof` is recognized as a contextual identifier when followed by
/// `(` and a type clause. The result is the unmanaged byte size of the
/// referenced type as an `int32`. The measured type must be an unmanaged
/// type — a blittable primitive, a blittable value struct, a pointer, or a
/// generic type parameter constrained `unmanaged`. Emits the CIL
/// `sizeof <T>` opcode (which accepts a generic type token), matching
/// C# `sizeof(T)` over a `where T : unmanaged` parameter.
class SizeOfExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:SizeOfExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param sizeOfIdentifier The `sizeof` identifier token.
    /// @param openParenthesis The `(` token.
    /// @param typeClause The type-clause argument.
    /// @param closeParenthesis The `)` token.
    init(
        syntaxTree SyntaxTree,
        sizeOfIdentifier SyntaxToken,
        openParenthesis SyntaxToken,
        typeClause TypeClauseSyntax,
        closeParenthesis SyntaxToken
    ) : base(syntaxTree) {
        SizeOfIdentifier = sizeOfIdentifier
        OpenParenthesis = openParenthesis
        TypeClause = typeClause
        CloseParenthesis = closeParenthesis
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SizeOfExpression

    /// Gets the `sizeof` identifier token.
    prop SizeOfIdentifier SyntaxToken {
        get;
    }

    /// Gets the opening `(` token.
    prop OpenParenthesis SyntaxToken {
        get;
    }

    /// Gets the type-clause argument.
    prop TypeClause TypeClauseSyntax {
        get;
    }

    /// Gets the closing `)` token.
    prop CloseParenthesis SyntaxToken {
        get;
    }
}
