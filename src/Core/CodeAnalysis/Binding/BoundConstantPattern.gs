// <copyright file="BoundConstantPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound constant pattern.
class BoundConstantPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundConstantPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param value The value expression.
    init(syntax SyntaxNode?, type TypeSymbol, value BoundExpression) : base(syntax, type) {
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ConstantPattern

    /// Gets the value expression.
    prop Value BoundExpression {
        get;
    }
}
