// <copyright file="ScopeException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Collections.Generic

/// The failure a `scope` throws when goroutines it owns failed (ADR-0174
/// D6). (cref:Exception.InnerException) is the first failure
/// — the scope body's own exception when it failed too, otherwise the child
/// failure that cancelled the siblings — and
/// (cref:AggregateException.InnerExceptions) lists every failure in
/// completion order. Sibling (cref:OperationCanceledException)s caused
/// by that first failure are not listed. Deriving from
/// (cref:AggregateException) keeps existing
/// `catch (AggregateException)` handlers working.
class ScopeException : AggregateException {
    /// Initializes a new instance of the (cref:ScopeException) class.
    /// @param failures The failures, first at index 0.
    init(failures IEnumerable[Exception]) : base(
        "One or more goroutines owned by a scope failed; InnerException is the first failure.",
        failures
    ) { }

    /// Gets the failure at index 0: the body's exception when the body failed, otherwise the child failure
    /// that cancelled its siblings.
    prop FirstFailure Exception -> InnerExceptions[0]
}
