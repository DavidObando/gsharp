// <copyright file="StructLiteralContentElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0180: a bare content element or content spread inside a struct/class
/// composite literal, e.g. the `Text("Account")` or `...rows` in
/// `Container{ Width: 320.0, Text("Account"), ...rows }`. Mirrors
/// (cref:ExpressionCollectionElementSyntax): a bare element lowers to
/// `Add(expr)` on the constructed receiver, and when
/// (cref:Expression) is a (cref:SpreadElementExpressionSyntax)
/// the source is evaluated once, iterated once, and each item is added in
/// order.
partial class StructLiteralContentElementSyntax : StructLiteralElementSyntax {
    /// Initializes a new instance of the (cref:StructLiteralContentElementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param expression The element expression (or a (cref:SpreadElementExpressionSyntax) for a content
    /// spread).
    init(syntaxTree SyntaxTree, expression ExpressionSyntax) : base(syntaxTree) {
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.StructLiteralContentElement

    /// Gets the element expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
