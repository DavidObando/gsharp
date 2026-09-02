// <copyright file="ScopeException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The failure a <c>scope</c> throws when goroutines it owns failed (ADR-0174
/// D6). <see cref="Exception.InnerException"/> is the first failure
/// — the scope body's own exception when it failed too, otherwise the child
/// failure that cancelled the siblings — and
/// <see cref="AggregateException.InnerExceptions"/> lists every failure in
/// completion order. Sibling <see cref="OperationCanceledException"/>s caused
/// by that first failure are not listed. Deriving from
/// <see cref="AggregateException"/> keeps existing
/// <c>catch (AggregateException)</c> handlers working.
/// </summary>
public sealed class ScopeException : AggregateException
{
    /// <summary>Initializes a new instance of the <see cref="ScopeException"/> class.</summary>
    /// <param name="failures">The failures, first at index 0.</param>
    public ScopeException(IEnumerable<Exception> failures)
        : base("One or more goroutines owned by a scope failed; InnerException is the first failure.", failures)
    {
    }

    /// <summary>Gets the failure at index 0: the body's exception when the body failed, otherwise the child failure that cancelled its siblings.</summary>
    public Exception FirstFailure => InnerExceptions[0];
}
