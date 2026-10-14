// <copyright file="TupleLiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a tuple literal expression `(e1, e2, ...)` (Phase 4.5).
class TupleLiteralExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:TupleLiteralExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openParenToken The opening `(`.
    /// @param elements The comma-separated tuple element expressions.
    /// @param closeParenToken The closing `)`.
    init(
        syntaxTree SyntaxTree,
        openParenToken SyntaxToken,
        elements SeparatedSyntaxList[ExpressionSyntax],
        closeParenToken SyntaxToken
    ) : base(syntaxTree) {
        OpenParenToken = openParenToken
        Elements = elements
        CloseParenToken = closeParenToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TupleLiteralExpression

    /// Gets the opening `(` token.
    prop OpenParenToken SyntaxToken {
        get;
    }

    /// Gets the tuple element expressions.
    prop Elements SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the closing `)` token.
    prop CloseParenToken SyntaxToken {
        get;
    }
}
