// <copyright file="Context.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Threading

/// The cancellation context every channel operation observes (ADR-0174 D6/D7).
/// A (cref:Context) is Go's `context.Context` reduced to what the
/// CLR already has — a (cref:CancellationToken) — plus ownership: a
/// context created by (cref:WithCancel) or (cref:WithTimeout)
/// owns a linked (cref:CancellationTokenSource), cancels its
/// descendants when it is cancelled, and releases the source on
/// (cref:Dispose). (cref:None) never cancels; it is what a root
/// or a public bridge supplies when no scope is ambient.
/// @remarks A (cref:Shielded()) context is cancellation-immune: a `defer` body
/// runs under one so cleanup that needs a channel still completes during an
/// unwind (D7). The grace budget that bounds a shielded region is enforced by
/// the scope machinery, not by the context itself.
class Context : IDisposable {
    private let source CancellationTokenSource?
    private var graceBudget TimeSpan

    private init(token CancellationToken, source CancellationTokenSource?, parent Context?, isShielded bool) {
        Token = token
        this.source = source
        Parent = parent
        IsShielded = isShielded
    }

    /// Gets the token a channel operation parks on.
    prop Token CancellationToken {
        get;
    }

    /// Gets the context this one was derived from, or `null` for a root.
    prop Parent Context? {
        get;
    }

    /// Gets a value indicating whether this context ignores its parent's cancellation (a `defer` body's
    /// context).
    prop IsShielded bool {
        get;
    }

    /// Gets a value indicating whether cancellation has been requested.
    prop IsCancelled bool -> Token.IsCancellationRequested

    /// Derives a child that cancels when this context cancels or when (cref:TryCancel) is called on the
    /// child.
    /// @returns The child context; dispose it when its scope ends.
    func WithCancel() Context {
        let linked = if Token.CanBeCanceled {
            CancellationTokenSource.CreateLinkedTokenSource(Token)
        } else {
            CancellationTokenSource()
        }
        return Context(linked.Token, linked, this, isShielded: false)
    }

    /// Derives a child that additionally cancels after [`timeout`](paramref).
    /// @param timeout The budget; (cref:Timeout.InfiniteTimeSpan) for none.
    /// @returns The child context; dispose it when its scope ends.
    func WithTimeout(timeout TimeSpan) Context {
        let child = WithCancel()
        child.source!!.CancelAfter(timeout) // WithCancel always builds a source; only Context.None lacks one.
        return child
    }

    /// Derives a cancellation-immune child for cleanup that must run during an unwind (ADR-0174 D7).
    /// @returns A context whose token never cancels and whose (cref:Parent) is this context.
    func Shielded() Context -> if object.ReferenceEquals(this, None) {
        None
    } else {
        Context(CancellationToken.None, source: nil, parent: this, isShielded: true)
    }

    /// Derives the shield a `defer` body runs under (ADR-0174 D7), using
    /// the host's current (cref:GsharpRuntime.DeferGraceBudget). The
    /// compiler calls this where it lowers deferred cleanup.
    /// @returns A shielded context, or (cref:None) when nothing can cancel this one.
    func ShieldedForCleanup() Context -> Shielded(GsharpRuntime.DeferGraceBudget)

    /// Derives a cancellation-immune child with a bounded grace budget
    /// (ADR-0174 D7). Cleanup running under it does not observe the outer
    /// cancellation, but it does not get to run forever either: when the budget
    /// expires the context cancels, the abandoned cleanup unwinds, and
    /// (cref:GsharpRuntime.DeferGraceExpired) reports it. An infinite
    /// budget is an unbounded shield.
    /// @param grace How long the shielded body may run; (cref:Timeout.InfiniteTimeSpan) for no deadline.
    /// @returns A shielded context whose (cref:Parent) is this context.
    func Shielded(grace TimeSpan) Context {
        // Nothing can cancel a body running under `None`, so it needs no shield
        // and no grace timer. This is the common case for cleanup outside any
        // scope, and keeping it allocation-free keeps `defer` cheap.
        if object.ReferenceEquals(this, None) || grace == Timeout.InfiniteTimeSpan {
            return Shielded()
        }
        let budget = CancellationTokenSource()
        let shielded = Context(budget.Token, budget, parent: this, isShielded: true)
        shielded.graceBudget = grace
        budget.Token.Register(
            (state object?) -> GsharpRuntime.RaiseDeferGraceExpired((cast[Context](state!!)).graceBudget),
            shielded
        )
        budget.CancelAfter(grace)
        return shielded
    }

    /// Requests cancellation of this context and every descendant, when this context owns its cancellation.
    /// @returns `true` when a cancellation was requested; `false` for (cref:None), a foreign-token wrapper,
    /// a shielded context, or a disposed one.
    func TryCancel() bool {
        if source == nil {
            return false
        }
        let source = source!!
        try {
            source.Cancel()
            return true
        } catch (ObjectDisposedException) {
            return false
        }
    }

    /// Throws (cref:OperationCanceledException) when cancellation has been requested.
    func ThrowIfCancelled() -> Token.ThrowIfCancellationRequested()

    /// Releases the owned cancellation source, if any. Descendants already derived keep their own sources.
    func Dispose() -> source?.Dispose()

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func ToString() string -> if object.ReferenceEquals(this, None) {
        "Context.None"
    } else {
        (
            if IsShielded {
                "Context(shielded)"
            } else {
                (
                    if IsCancelled {
                        "Context(cancelled)"
                    } else {
                        "Context"
                    }
                )
            }
        )
    }

    shared {
        /// Gets the context that never cancels.
        private let _none Context = Context(CancellationToken.None, source: nil, parent: nil, isShielded: false)

        prop None Context {
            get {
                return _none
            }
        }

        /// Wraps a foreign token — the boundary where a C# caller's cancellation enters G#.
        /// @param token The token; a token that can never cancel yields (cref:None).
        /// @returns A context observing [`token`](paramref).
        func FromToken(token CancellationToken) Context -> if token.CanBeCanceled {
            Context(token, source: nil, parent: nil, isShielded: false)
        } else {
            None
        }
    }
}
