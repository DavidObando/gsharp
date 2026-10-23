// <copyright file="BinaryExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a binary expression in the language.
open partial class BinaryExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:BinaryExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param left The left side of the binary expression.
    /// @param operatorToken The operator.
    /// @param right The right side of the binary expression.
    init(syntaxTree SyntaxTree, left ExpressionSyntax, operatorToken SyntaxToken, right ExpressionSyntax) : base(
        syntaxTree
    ) {
        Left = left
        OperatorToken = operatorToken
        Right = right
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SyntaxKind -> SyntaxKind.BinaryExpression

    /// Gets the left side of the binary expression.
    prop Left ExpressionSyntax {
        get;
    }

    /// Gets the operator.
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the right side of the binary expression.
    prop Right ExpressionSyntax {
        get;
    }
}
