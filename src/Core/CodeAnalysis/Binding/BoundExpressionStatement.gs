// <copyright file="BoundExpressionStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression statement.
class BoundExpressionStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundExpressionStatement) class.
    /// @param syntax The originating syntax.
    /// @param expression The expression.
    init(syntax SyntaxNode?, expression BoundExpression) : base(syntax) {
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ExpressionStatement

    /// Gets the expression.
    prop Expression BoundExpression {
        get;
    }
}
