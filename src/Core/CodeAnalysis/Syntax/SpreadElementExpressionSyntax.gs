// <copyright file="SpreadElementExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an ellipsis spread inside an array or collection initializer,
/// e.g. `...items` in `[]int32{ 0, ...items, 9 }`.
partial class SpreadElementExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:SpreadElementExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param ellipsisToken The leading `...` token.
    /// @param expression The enumerable source expression.
    init(syntaxTree SyntaxTree, ellipsisToken SyntaxToken, expression ExpressionSyntax) : base(syntaxTree) {
        EllipsisToken = ellipsisToken
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SpreadElementExpression

    /// Gets the leading `...` token.
    prop EllipsisToken SyntaxToken {
        get;
    }

    /// Gets the enumerable source expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
