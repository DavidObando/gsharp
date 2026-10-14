// <copyright file="BoundSelectCase.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Diagnostics.CodeAnalysis

/// A single bound arm of a `select` statement (Phase 5.6 / ADR-0022).
data class BoundSelectCase : IEquatable[BoundSelectCase] {
    /// Initializes a new instance of the (cref:BoundSelectCase) class.
    /// @param caseKind Which arm shape this is.
    /// @param channel Channel expression for send/receive arms; null for default.
    /// @param value Value expression for send arms; null otherwise.
    /// @param variable Declared variable for `case v := <-ch`; null otherwise.
    /// @param body Bound case body.
    convenience init(
        caseKind SelectCaseKind,
        channel BoundExpression?,
        value BoundExpression?,
        variable VariableSymbol?,
        body BoundStatement
    ) {
        init(caseKind, channel, value, variable, nil, body)
    }

    /// Initializes a new instance of the (cref:BoundSelectCase) class.
    /// @param caseKind Which arm shape this is.
    /// @param channel Channel, selectable or task operand; null for default and cancelled arms.
    /// @param value Value expression for send arms; null otherwise.
    /// @param variable Declared variable for a binding arm; null otherwise.
    /// @param guard The arm's `when` guard (ADR-0174 D8); null when it has none.
    /// @param body Bound case body.
    init(
        caseKind SelectCaseKind,
        channel BoundExpression?,
        value BoundExpression?,
        variable VariableSymbol?,
        $guard BoundExpression?,
        body BoundStatement
    ) {
        CaseKind = caseKind
        Channel = channel
        Value = value
        Variable = variable
        Guard = $guard
        Body = body
    }

    /// Gets the arm shape.
    prop CaseKind SelectCaseKind {
        get;
    }

    /// Gets the channel expression for send/receive arms; null for default.
    prop Channel BoundExpression? {
        get;
    }

    /// Gets the value expression for send arms; null otherwise.
    prop Value BoundExpression? {
        get;
    }

    /// Gets the declared variable for receive-bind arms; null otherwise.
    prop Variable VariableSymbol? {
        get;
    }

    /// Gets the arm's `when` guard (ADR-0174 D8), or `null`.
    /// Evaluated once when the select is entered; a false guard keeps the arm
    /// out of the waiter entirely.
    prop Guard BoundExpression? {
        get;
    }

    /// Gets the bound case body.
    prop Body BoundStatement {
        get;
    }

    // Every non-default arm references a channel -- the binder binds one before
    // it can classify the arm at all, including on the error-recovery path.
    // Value has no such guarantee: a send arm whose channel failed to bind is
    // recovered with a null value.
    /// Gets a value indicating whether this is the `default` arm.
    @MemberNotNullWhen(false, "Channel")
    prop IsDefault bool -> CaseKind == SelectCaseKind.Default
}
