// <copyright file="BoundTryStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound `try { … } catch (e T) { … } finally { … }` statement.
class BoundTryStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundTryStatement) class.
    /// @param syntax The originating syntax.
    /// @param tryBlock The protected block.
    /// @param catchClauses The bound catch clauses (possibly empty).
    /// @param finallyBlock The finally block, or `null` for a
    /// `try`/`catch` with no `finally`.
    init(
        syntax SyntaxNode?,
        tryBlock BoundStatement,
        catchClauses ImmutableArray[BoundCatchClause],
        finallyBlock BoundStatement?
    ) : base(syntax) {
        TryBlock = tryBlock
        CatchClauses = catchClauses
        FinallyBlock = finallyBlock
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.TryStatement

    /// Gets the protected block.
    prop TryBlock BoundStatement {
        get;
    }

    /// Gets the bound catch clauses.
    prop CatchClauses ImmutableArray[BoundCatchClause] {
        get;
    }

    /// Gets the finally block, or `null` for a `try`/`catch`
    /// with no `finally`.
    prop FinallyBlock BoundStatement? {
        get;
    }
}
