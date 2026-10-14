// <copyright file="BoundBinaryExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound binary expression.
class BoundBinaryExpression : BoundBinaryOperationExpression {
    /// Initializes a new instance of the (cref:BoundBinaryExpression) class.
    /// @param syntax The originating syntax.
    /// @param left The left bound expression.
    /// @param op The bound binary operator.
    /// @param right The right bound expression.
    /// @param isChecked When true and [`op`](paramref) is Sum/Difference/Product, the emitter
    /// and interpreter use overflow-trapping arithmetic (issue #1881): a
    /// `checked(...)` expression or `checked { }` statement puts its arithmetic
    /// in this context; the default (no `checked` context) is unchecked, matching
    /// the C# project default.
    init(
        syntax SyntaxNode?,
        left BoundExpression,
        op BoundBinaryOperator,
        right BoundExpression,
        isChecked bool = false
    ) : base(syntax) {
        _left = left
        Op = op
        _right = right
        IsChecked = isChecked
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.BinaryExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> Op.Type

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop BinaryOperatorKind BoundBinaryOperatorKind -> Op.Kind

    /// Gets the left bound expression.
    private var _left BoundExpression

    override prop Left BoundExpression -> _left

    /// Gets the bound binary operator.
    prop Op BoundBinaryOperator {
        get;
    }

    /// Gets the rught bound expression.
    private var _right BoundExpression

    override prop Right BoundExpression -> _right

    /// Gets a value indicating whether this operator runs in a checked /
    /// overflow-trapping context (issue #1881). Only observed for Sum,
    /// Difference, and Product on integral operands.
    prop IsChecked bool {
        get;
    }
}
