// <copyright file="BoundBlockExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// An expression that evaluates synthetic statements before yielding a final expression value.
class BoundBlockExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundBlockExpression) class.
    /// @param syntax The originating syntax.
    /// @param statements The synthetic prefix statements.
    /// @param expression The resulting expression.
    init(syntax SyntaxNode?, statements ImmutableArray[BoundStatement], expression BoundExpression) : base(syntax) {
        Statements = statements
        Expression = expression
    }

    /// Gets the synthetic prefix statements.
    prop Statements ImmutableArray[BoundStatement] {
        get;
    }

    /// Gets the resulting expression.
    prop Expression BoundExpression {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> Expression.Type

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.BlockExpression
}
