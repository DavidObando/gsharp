// <copyright file="BoundBlockStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound block statement.
class BoundBlockStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundBlockStatement) class.
    /// @param syntax The originating syntax.
    /// @param statements The immutable array of bound statements.
    convenience init(syntax SyntaxNode?, statements ImmutableArray[BoundStatement]) {
        init(syntax, statements, nil)
    }

    internal init(
        syntax SyntaxNode?,
        statements ImmutableArray[BoundStatement],
        preEmitAnalysisBody BoundBlockStatement?
    ) : base(syntax) {
        Statements = statements
        PreEmitAnalysisBody = preEmitAnalysisBody
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.BlockStatement

    /// Gets the immutable array of bound statements.
    prop Statements ImmutableArray[BoundStatement] {
        get;
    }

    /// Gets the pre-emit-rewrite body used by control-flow analyses.
    internal prop PreEmitAnalysisBody BoundBlockStatement? {
        get;
    }
}
