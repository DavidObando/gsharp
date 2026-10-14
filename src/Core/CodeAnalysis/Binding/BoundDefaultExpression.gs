// <copyright file="BoundDefaultExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression representing `default(T)` — the zero/null value of a type.
/// For reference types this is `null`; for value types it is the all-zeros bit pattern.
class BoundDefaultExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundDefaultExpression) class.
    /// @param syntax The originating syntax.
    /// @param type The type whose default value this expression produces.
    init(syntax SyntaxNode?, type TypeSymbol) : base(syntax) {
        _type = type
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.DefaultExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type
}
