// <copyright file="BoundCatchClause.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System

/// Bound catch clause attached to a (cref:BoundTryStatement).
data class BoundCatchClause : IEquatable[BoundCatchClause] {
    /// Initializes a new instance of the (cref:BoundCatchClause) class.
    /// @param exceptionType The exception type filter; `null` matches the base exception type.
    /// @param variable The local variable holding the caught instance, or `null` for an unbound clause.
    /// @param body The handler block.
    convenience init(exceptionType TypeSymbol, variable VariableSymbol?, body BoundStatement) {
        init(exceptionType, variable, body, false)
    }

    /// Initializes a new instance of the (cref:BoundCatchClause) class.
    /// @param exceptionType The exception type filter; `null` matches the base exception type.
    /// @param variable The local variable holding the caught instance, or `null` for an unbound clause.
    /// @param body The handler block.
    /// @param exitsThroughFinally See (cref:ExitsThroughFinally).
    convenience init(
        exceptionType TypeSymbol,
        variable VariableSymbol?,
        body BoundStatement,
        exitsThroughFinally bool
    ) {
        init(exceptionType, variable, nil, body, exitsThroughFinally)
    }

    /// Initializes a new instance of the (cref:BoundCatchClause) class.
    /// @param exceptionType The exception type filter; `null` matches the base exception type.
    /// @param variable The local variable holding the caught instance, or `null` for an unbound clause.
    /// @param filter See (cref:Filter).
    /// @param body The handler block.
    /// @param exitsThroughFinally See (cref:ExitsThroughFinally).
    init(
        exceptionType TypeSymbol,
        variable VariableSymbol?,
        filter BoundExpression?,
        body BoundStatement,
        exitsThroughFinally bool
    ) {
        ExceptionType = exceptionType
        Variable = variable
        Filter = filter
        Body = body
        ExitsThroughFinally = exitsThroughFinally
    }

    /// Gets the exception type filter for this clause.
    prop ExceptionType TypeSymbol {
        get;
    }

    /// Gets the bound variable holding the caught instance, or `null` when
    /// the clause does not bind one (ADR-0177: `catch (Type)` and bare
    /// `catch`). The emitter pops the exception off the stack in that case.
    prop Variable VariableSymbol? {
        get;
    }

    /// Gets the optional `when` filter expression (ADR-0177), or `null`
    /// when the clause has none. A filter is emitted as a real CLR filter region:
    /// it runs in the first pass, before any intervening `finally`, and a
    /// `false` result declines the clause and continues the search with the
    /// next sibling handler.
    prop Filter BoundExpression? {
        get;
    }

    /// Gets the handler block.
    prop Body BoundStatement {
        get;
    }

    /// Gets a value indicating whether the handler only records the exception
    /// for a `finally` that is guaranteed to rethrow it, so control never
    /// completes the handler normally. The binder sets this on the catch it
    /// synthesizes for a `scope` block (ADR-0174 D6: `ScopeFrame.Exit`
    /// always throws when handed a body exception); control-flow analysis
    /// treats such a handler as terminating, so `return` inside the
    /// scope body still satisfies "all paths return".
    prop ExitsThroughFinally bool {
        get;
    }

    /// Returns a clause with the same filter, variable and (cref:ExitsThroughFinally) and a rewritten body.
    /// @param body The rewritten handler block.
    /// @returns The clause, or `this` when the body is unchanged.
    func WithBody(body BoundStatement) BoundCatchClause -> if object.ReferenceEquals(body, Body) {
        this
    } else {
        BoundCatchClause(ExceptionType, Variable, Filter, body, ExitsThroughFinally)
    }

    /// Returns a clause with a rewritten filter and body.
    /// @param filter The rewritten filter expression, or `null`.
    /// @param body The rewritten handler block.
    /// @returns The clause, or `this` when neither part changed.
    func Update(filter BoundExpression?, body BoundStatement) BoundCatchClause -> if object.ReferenceEquals(
        body,
        Body
    ) &&
        object.ReferenceEquals(filter, Filter) {
        this
    } else {
        BoundCatchClause(ExceptionType, Variable, filter, body, ExitsThroughFinally)
    }
}
