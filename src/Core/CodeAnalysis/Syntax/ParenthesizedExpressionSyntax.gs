// <copyright file="ParenthesizedExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a parenthesized expression in the language.
class ParenthesizedExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:ParenthesizedExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openParenthesisToken The open parenthesys token.
    /// @param expression The expression.
    /// @param closeParenthesisToken The close parenthesys token.
    init(
        syntaxTree SyntaxTree,
        openParenthesisToken SyntaxToken,
        expression ExpressionSyntax,
        closeParenthesisToken SyntaxToken
    ) : base(syntaxTree) {
        OpenParenthesisToken = openParenthesisToken
        Expression = expression
        CloseParenthesisToken = closeParenthesisToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ParenthesizedExpression

    /// Gets the open parenthesis token.
    prop OpenParenthesisToken SyntaxToken {
        get;
    }

    /// Gets the expression.
    prop Expression ExpressionSyntax {
        get;
    }

    /// Gets the close parenthesis token.
    prop CloseParenthesisToken SyntaxToken {
        get;
    }
}
