// <copyright file="BoundForEllipsisStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound for ellipsis statement.
class BoundForEllipsisStatement : BoundLoopStatement {
    /// Initializes a new instance of the (cref:BoundForEllipsisStatement) class.
    /// @param syntax The originating syntax.
    /// @param variable The variable.
    /// @param lowerBound The lower bound expression.
    /// @param upperBound The upper bound expression.
    /// @param body The body.
    /// @param breakLabel The break label.
    /// @param continueLabel The continue label.
    init(
        syntax SyntaxNode?,
        variable VariableSymbol,
        lowerBound BoundExpression,
        upperBound BoundExpression,
        body BoundStatement,
        breakLabel BoundLabel,
        continueLabel BoundLabel
    ) : base(syntax, breakLabel, continueLabel) {
        Variable = variable
        LowerBound = lowerBound
        UpperBound = upperBound
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ForEllipsisStatement

    /// Gets the variable.
    prop Variable VariableSymbol {
        get;
    }

    /// Gets the lower bound expression.
    prop LowerBound BoundExpression {
        get;
    }

    /// Gets the upper bound expression.
    prop UpperBound BoundExpression {
        get;
    }

    /// Gets the body.
    prop Body BoundStatement {
        get;
    }
}
