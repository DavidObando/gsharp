// <copyright file="TypeOfExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the built-in `typeof(T)` operator (issue #143).
/// `typeof` is recognized as a contextual identifier when followed by
/// `(` and a type clause. The result is a (cref:System.Type)
/// obtained from the type's metadata token.
class TypeOfExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:TypeOfExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param typeOfIdentifier The `typeof` identifier token.
    /// @param openParenthesis The `(` token.
    /// @param typeClause The type-clause argument.
    /// @param closeParenthesis The `)` token.
    init(
        syntaxTree SyntaxTree,
        typeOfIdentifier SyntaxToken,
        openParenthesis SyntaxToken,
        typeClause TypeClauseSyntax,
        closeParenthesis SyntaxToken
    ) : base(syntaxTree) {
        TypeOfIdentifier = typeOfIdentifier
        OpenParenthesis = openParenthesis
        TypeClause = typeClause
        CloseParenthesis = closeParenthesis
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TypeOfExpression

    /// Gets the `typeof` identifier token.
    prop TypeOfIdentifier SyntaxToken {
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
