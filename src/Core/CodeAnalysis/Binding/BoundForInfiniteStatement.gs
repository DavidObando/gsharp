// <copyright file="BoundForInfiniteStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound for infinite statement.
class BoundForInfiniteStatement : BoundLoopStatement {
    /// Initializes a new instance of the (cref:BoundForInfiniteStatement) class.
    /// @param syntax The originating syntax.
    /// @param body The body.
    /// @param breakLabel The break label.
    /// @param continueLabel The continue label.
    init(syntax SyntaxNode?, body BoundStatement, breakLabel BoundLabel, continueLabel BoundLabel) : base(
        syntax,
        breakLabel,
        continueLabel
    ) {
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ForInfiniteStatement

    /// Gets the body.
    prop Body BoundStatement {
        get;
    }
}
