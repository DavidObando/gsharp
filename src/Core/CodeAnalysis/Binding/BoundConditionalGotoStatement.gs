// <copyright file="BoundConditionalGotoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound conditional goto statement.
class BoundConditionalGotoStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundConditionalGotoStatement) class.
    /// @param syntax The originating syntax.
    /// @param label The label.
    /// @param condition The condition.
    /// @param jumpIfTrue Whether to jump on true, or on false.
    init(syntax SyntaxNode?, label BoundLabel, condition BoundExpression, jumpIfTrue bool = true) : base(syntax) {
        Label = label
        Condition = condition
        JumpIfTrue = jumpIfTrue
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ConditionalGotoStatement

    /// Gets the label.
    prop Label BoundLabel {
        get;
    }

    /// Gets the condition.
    prop Condition BoundExpression {
        get;
    }

    /// Gets a value indicating whether to jump on true, or on false.
    prop JumpIfTrue bool {
        get;
    }
}
