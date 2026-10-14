// <copyright file="BoundIfStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound if statement.
class BoundIfStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundIfStatement) class.
    /// @param syntax The originating syntax.
    /// @param condition The bound if statement condition.
    /// @param thenStatement The then statement.
    /// @param elseStatement The else statement, or `null` for an
    /// `if` with no `else` clause.
    init(
        syntax SyntaxNode?,
        condition BoundExpression,
        thenStatement BoundStatement,
        elseStatement BoundStatement?
    ) : base(syntax) {
        Condition = condition
        ThenStatement = thenStatement
        ElseStatement = elseStatement
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.IfStatement

    /// Gets the bound if statement condition.
    prop Condition BoundExpression {
        get;
    }

    /// Gets the then statement.
    prop ThenStatement BoundStatement {
        get;
    }

    /// Gets the else statement, or `null` for an `if` with no
    /// `else` clause. Every rewriter and walker over this node already
    /// tests it before recursing.
    prop ElseStatement BoundStatement? {
        get;
    }
}
