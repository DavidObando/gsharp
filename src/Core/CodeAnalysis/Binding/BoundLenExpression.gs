// <copyright file="BoundLenExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound built-in `len(x)` expression. Returns the element count
/// of an array, slice, or string.
class BoundLenExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundLenExpression) class.
    /// @param syntax The originating syntax.
    /// @param operand The operand expression.
    init(syntax SyntaxNode?, operand BoundExpression) : base(syntax) {
        Operand = operand
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.LenExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> TypeSymbol.Int32

    /// Gets the operand expression.
    prop Operand BoundExpression {
        get;
    }
}
