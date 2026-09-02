// <copyright file="IGoroutineSink.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The exactly-one completion sink every goroutine reports to (ADR-0174 D5).
/// A scoped goroutine's sink is its <see cref="ScopeFrame"/>; a free one's is
/// <see cref="GoroutineRuntime.FreeSink"/>. The work item calls
/// <see cref="Register"/> before it is queued and exactly one of
/// <see cref="Complete"/> or <see cref="Fail"/> when the body's
/// <see cref="ValueTask"/> has been consumed.
/// </summary>
public interface IGoroutineSink
{
    /// <summary>Gets the ambient cancellation context the goroutine body runs under.</summary>
    Context Context { get; }

    /// <summary>Records that a goroutine is about to be queued. Called before <c>UnsafeQueueUserWorkItem</c>, never after.</summary>
    void Register();

    /// <summary>Records that a registered goroutine ran to completion.</summary>
    void Complete();

    /// <summary>Records that a registered goroutine faulted.</summary>
    /// <param name="exception">The body's exception, unwrapped.</param>
    void Fail(Exception exception);
}
