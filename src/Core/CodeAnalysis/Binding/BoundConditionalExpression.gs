// <copyright file="BoundConditionalExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0062: bound representation of a general two-arm conditional (ternary)
/// expression of the form `<cond> ? <ifTrue> : <ifFalse>`.
/// Only one arm is evaluated at runtime. The result type is the common type
/// chosen by the binder using identity / implicit conversion / numeric
/// tie-break rules; both arm values are already converted to that result type.
class BoundConditionalExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundConditionalExpression) class.
    /// @param syntax The originating syntax.
    /// @param condition The bound condition (typed `bool`).
    /// @param whenTrue The bound true-branch expression, already converted to [`type`](paramref).
    /// @param whenFalse The bound false-branch expression, already converted to [`type`](paramref).
    /// @param type The common result type chosen for the conditional.
    init(
        syntax SyntaxNode?,
        condition BoundExpression,
        whenTrue BoundExpression,
        whenFalse BoundExpression,
        type TypeSymbol
    ) : base(syntax) {
        Condition = condition
        WhenTrue = whenTrue
        WhenFalse = whenFalse
        _type = type
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ConditionalExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the bound condition (typed `bool`).
    prop Condition BoundExpression {
        get;
    }

    /// Gets the bound true-branch expression.
    prop WhenTrue BoundExpression {
        get;
    }

    /// Gets the bound false-branch expression.
    prop WhenFalse BoundExpression {
        get;
    }
}
