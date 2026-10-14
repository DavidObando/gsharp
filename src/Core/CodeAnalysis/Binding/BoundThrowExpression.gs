// <copyright file="BoundThrowExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Issue #1018: bound representation of a `throw expr` used in expression
/// position. The expression never produces a value — it always transfers
/// control by raising (cref:System.Exception) — so its static
/// (cref:Type) is the bottom ((cref:TypeSymbol.Never)) type,
/// which the conversion / common-type machinery treats as implicitly
/// convertible to any target type.
class BoundThrowExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundThrowExpression) class.
    /// @param syntax The originating syntax.
    /// @param expression The bound exception expression.
    init(syntax SyntaxNode?, expression BoundExpression) : base(syntax) {
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ThrowExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> TypeSymbol.Never

    /// Gets the bound exception expression.
    prop Expression BoundExpression {
        get;
    }
}
