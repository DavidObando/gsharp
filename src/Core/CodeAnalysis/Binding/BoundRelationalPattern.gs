// <copyright file="BoundRelationalPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound relational pattern.
class BoundRelationalPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundRelationalPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param op The operator.
    /// @param value The right-hand value.
    init(syntax SyntaxNode?, type TypeSymbol, op BoundBinaryOperator, value BoundExpression) : base(syntax, type) {
        Op = op
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.RelationalPattern

    /// Gets the relational operator.
    prop Op BoundBinaryOperator {
        get;
    }

    /// Gets the right-hand value expression.
    prop Value BoundExpression {
        get;
    }
}
