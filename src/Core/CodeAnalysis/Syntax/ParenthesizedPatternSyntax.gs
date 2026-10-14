// <copyright file="ParenthesizedPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a parenthesized pattern `( ... )` used to override the
/// default combinator precedence (`not` > `and` > `or`).
class ParenthesizedPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:ParenthesizedPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openParenthesisToken The opening parenthesis.
    /// @param pattern The inner pattern.
    /// @param closeParenthesisToken The closing parenthesis.
    init(
        syntaxTree SyntaxTree,
        openParenthesisToken SyntaxToken,
        pattern PatternSyntax,
        closeParenthesisToken SyntaxToken
    ) : base(syntaxTree) {
        OpenParenthesisToken = openParenthesisToken
        Pattern = pattern
        CloseParenthesisToken = closeParenthesisToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ParenthesizedPattern

    /// Gets the opening parenthesis token.
    prop OpenParenthesisToken SyntaxToken {
        get;
    }

    /// Gets the inner pattern.
    prop Pattern PatternSyntax {
        get;
    }

    /// Gets the closing parenthesis token.
    prop CloseParenthesisToken SyntaxToken {
        get;
    }
}
