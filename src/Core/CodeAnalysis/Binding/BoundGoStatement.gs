// <copyright file="BoundGoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound `go f(args)` statement (Phase 5.3 / ADR-0022). The
/// expression is a call (or call-returning expression) that runs on a
/// background (cref:System.Threading.Tasks.Task).
class BoundGoStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundGoStatement) class.
    /// @param syntax The originating syntax.
    /// @param expression The bound call expression to dispatch.
    convenience init(syntax SyntaxNode?, expression BoundExpression) {
        init(syntax, expression, nil)
    }

    /// Initializes a new instance of the (cref:BoundGoStatement) class with a completion sink.
    /// @param syntax The originating syntax.
    /// @param expression The bound call expression to dispatch, shaped to yield a `ValueTask` (or `void`).
    /// @param sink The enclosing scope's frame (ADR-0174 D5), or `null` for a free goroutine reporting to
    /// the runtime's sink.
    convenience init(syntax SyntaxNode?, expression BoundExpression, sink BoundExpression?) {
        init(syntax, expression, sink, nil, nil, nil)
    }

    /// Initializes a new instance of the (cref:BoundGoStatement) class for an `async let` child.
    /// @param syntax The originating syntax.
    /// @param expression The bound call expression to dispatch. Its result is kept, not discarded.
    /// @param sink The child's cell, which is also its completion sink.
    /// @param resultCell A read of the `AsyncLetCell[R]` the child's value is deposited into (ADR-0174
    /// D15), or `null` for an ordinary `go`.
    /// @param resultType The binding's type `R`, carried alongside the cell because a same-compilation type
    /// travels symbolically and the cell's CLR type closes over `object`.
    /// @param lexicalEnclosingType The user-defined type whose member-access domain the synthesized
    /// goroutine helper must retain.
    init(
        syntax SyntaxNode?,
        expression BoundExpression,
        sink BoundExpression?,
        resultCell BoundExpression?,
        resultType TypeSymbol?,
        lexicalEnclosingType TypeSymbol? = nil
    ) : base(syntax) {
        Expression = expression
        Sink = sink
        ResultCell = resultCell
        ResultType = resultType
        LexicalEnclosingType = lexicalEnclosingType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.GoStatement

    /// Gets the bound expression to dispatch.
    prop Expression BoundExpression {
        get;
    }

    /// Gets the completion sink expression (the enclosing scope frame), or `null` for a free goroutine.
    prop Sink BoundExpression? {
        get;
    }

    /// Gets the `AsyncLetCell[R]` this child deposits its value into
    /// (ADR-0174 D15), or `null` when the result is discarded
    /// as an ordinary `go` discards it. The suspension pass wraps the
    /// operand in `cell.Run(…)`: the overload is chosen from the operand's
    /// <em>rewritten</em> type, because an inferred callee is typed `R`
    /// when the binder sees it and `ValueTask[R]` after the fixed point.
    prop ResultCell BoundExpression? {
        get;
    }

    /// Gets the `async let` binding's type, or `null` for an ordinary `go`.
    prop ResultType TypeSymbol? {
        get;
    }

    /// Gets the nearest enclosing user-defined type whose accessibility domain
    /// the synthesized goroutine helper must retain.
    prop LexicalEnclosingType TypeSymbol? {
        get;
    }
}
