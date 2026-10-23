// <copyright file="ExpressionCollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #479 / ADR-0117: a bare element of a sequence/set collection
/// initializer, e.g. the `1` in `List[int32]{1, 2, 3}`. Lowers to a
/// `Add(expr)` call on the constructed collection. When
/// (cref:Expression) is a (cref:SpreadElementExpressionSyntax),
/// each source element is added in order.
partial class ExpressionCollectionElementSyntax : CollectionElementSyntax {
    /// Initializes a new instance of the (cref:ExpressionCollectionElementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param expression The element expression.
    init(syntaxTree SyntaxTree, expression ExpressionSyntax) : base(syntaxTree) {
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ExpressionCollectionElement

    /// Gets the element expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
