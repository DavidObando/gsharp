// <copyright file="LiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a literal expression in the language.
partial class LiteralExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:LiteralExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param literalToken The literal token.
    convenience init(syntaxTree SyntaxTree, literalToken SyntaxToken) {
        init(syntaxTree, literalToken, literalToken.Value)
    }

    /// Initializes a new instance of the (cref:LiteralExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param literalToken The literal token.
    /// @param value The literal expression value.
    init(syntaxTree SyntaxTree, literalToken SyntaxToken, value object?) : base(syntaxTree) {
        LiteralToken = literalToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.LiteralExpression

    /// Gets the literal token.
    prop LiteralToken SyntaxToken {
        get;
    }

    /// Gets the literal value.
    prop Value object? {
        get;
    }
}
