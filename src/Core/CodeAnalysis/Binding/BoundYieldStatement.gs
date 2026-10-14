// <copyright file="BoundYieldStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound yield statement — produces the next value in an iterator function (ADR-0040).
class BoundYieldStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundYieldStatement) class.
    /// @param syntax The originating syntax.
    /// @param expression The expression whose value is yielded.
    init(syntax SyntaxNode?, expression BoundExpression) : base(syntax) {
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.YieldStatement

    /// Gets the expression whose value is yielded to the caller.
    prop Expression BoundExpression {
        get;
    }
}
