// <copyright file="NameOfExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the built-in `nameof(expr)` operator (issue #143).
/// `nameof` is recognized as a contextual identifier when followed by
/// `(`. The argument must be a name reference (identifier, member access,
/// or generic type instantiation); the binder lowers it to a compile-time
/// string literal of the unqualified short name.
partial class NameOfExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:NameOfExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param nameOfIdentifier The `nameof` identifier token.
    /// @param openParenthesis The `(` token.
    /// @param argument The argument expression — must reduce to a name reference.
    /// @param closeParenthesis The `)` token.
    init(
        syntaxTree SyntaxTree,
        nameOfIdentifier SyntaxToken,
        openParenthesis SyntaxToken,
        argument ExpressionSyntax,
        closeParenthesis SyntaxToken
    ) : base(syntaxTree) {
        NameOfIdentifier = nameOfIdentifier
        OpenParenthesis = openParenthesis
        Argument = argument
        CloseParenthesis = closeParenthesis
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.NameOfExpression

    /// Gets the `nameof` identifier token.
    prop NameOfIdentifier SyntaxToken {
        get;
    }

    /// Gets the opening `(` token.
    prop OpenParenthesis SyntaxToken {
        get;
    }

    /// Gets the argument expression.
    prop Argument ExpressionSyntax {
        get;
    }

    /// Gets the closing `)` token.
    prop CloseParenthesis SyntaxToken {
        get;
    }
}
