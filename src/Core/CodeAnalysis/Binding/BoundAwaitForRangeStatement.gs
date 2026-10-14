// <copyright file="BoundAwaitForRangeStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Phase 5.8 / ADR-0023: bound form of
/// `await for v := range stream { ... }`. The stream operand is
/// an `IAsyncEnumerable[T]`; the value variable is typed as
/// `T`. The interpreter realizes the loop by reflection on
/// `GetAsyncEnumerator`/`MoveNextAsync`/`Current`/
/// `DisposeAsync`, blocking on each underlying `ValueTask`
/// via `GetAwaiter().GetResult()` (the same synchronous-await
/// idiom Phase 5.1 uses for plain `await`). The async-aware
/// lowering and emit are deferred.
class BoundAwaitForRangeStatement : BoundLoopStatement {
    /// Initializes a new instance of the (cref:BoundAwaitForRangeStatement) class.
    /// @param syntax The originating syntax.
    /// @param valueVariable The element variable.
    /// @param stream The async-stream expression.
    /// @param body The loop body.
    /// @param breakLabel The break label targeted by `break` inside the loop body.
    /// @param continueLabel The continue label targeted by `continue` inside the loop body.
    init(
        syntax SyntaxNode?,
        valueVariable VariableSymbol,
        stream BoundExpression,
        body BoundStatement,
        breakLabel BoundLabel,
        continueLabel BoundLabel
    ) : base(syntax, breakLabel, continueLabel) {
        ValueVariable = valueVariable
        Stream = stream
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.AwaitForRangeStatement

    /// Gets the element variable, typed as the stream's element type.
    prop ValueVariable VariableSymbol {
        get;
    }

    /// Gets the async-stream expression.
    prop Stream BoundExpression {
        get;
    }

    /// Gets the loop body.
    prop Body BoundStatement {
        get;
    }
}
