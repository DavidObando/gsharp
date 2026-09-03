// <copyright file="Context.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The cancellation context every channel operation observes (ADR-0174 D6/D7).
/// A <see cref="Context"/> is Go's <c>context.Context</c> reduced to what the
/// CLR already has — a <see cref="CancellationToken"/> — plus ownership: a
/// context created by <see cref="WithCancel"/> or <see cref="WithTimeout"/>
/// owns a linked <see cref="CancellationTokenSource"/>, cancels its
/// descendants when it is cancelled, and releases the source on
/// <see cref="Dispose"/>. <see cref="None"/> never cancels; it is what a root
/// or a public bridge supplies when no scope is ambient.
/// </summary>
/// <remarks>
/// A <see cref="Shielded()"/> context is cancellation-immune: a <c>defer</c> body
/// runs under one so cleanup that needs a channel still completes during an
/// unwind (D7). The grace budget that bounds a shielded region is enforced by
/// the scope machinery, not by the context itself.
/// </remarks>
public sealed class Context : IDisposable
{
    private readonly CancellationTokenSource? source;
    private TimeSpan graceBudget;

    private Context(CancellationToken token, CancellationTokenSource? source, Context? parent, bool isShielded)
    {
        Token = token;
        this.source = source;
        Parent = parent;
        IsShielded = isShielded;
    }

    /// <summary>Gets the context that never cancels.</summary>
    public static Context None { get; } = new(CancellationToken.None, source: null, parent: null, isShielded: false);

    /// <summary>Gets the token a channel operation parks on.</summary>
    public CancellationToken Token { get; }

    /// <summary>Gets the context this one was derived from, or <see langword="null"/> for a root.</summary>
    public Context? Parent { get; }

    /// <summary>Gets a value indicating whether this context ignores its parent's cancellation (a <c>defer</c> body's context).</summary>
    public bool IsShielded { get; }

    /// <summary>Gets a value indicating whether cancellation has been requested.</summary>
    public bool IsCancelled => Token.IsCancellationRequested;

    /// <summary>Wraps a foreign token — the boundary where a C# caller's cancellation enters G#.</summary>
    /// <param name="token">The token; a token that can never cancel yields <see cref="None"/>.</param>
    /// <returns>A context observing <paramref name="token"/>.</returns>
    public static Context FromToken(CancellationToken token)
        => token.CanBeCanceled ? new Context(token, source: null, parent: null, isShielded: false) : None;

    /// <summary>Derives a child that cancels when this context cancels or when <see cref="TryCancel"/> is called on the child.</summary>
    /// <returns>The child context; dispose it when its scope ends.</returns>
    public Context WithCancel()
    {
        var linked = Token.CanBeCanceled
            ? CancellationTokenSource.CreateLinkedTokenSource(Token)
            : new CancellationTokenSource();
        return new Context(linked.Token, linked, this, isShielded: false);
    }

    /// <summary>Derives a child that additionally cancels after <paramref name="timeout"/>.</summary>
    /// <param name="timeout">The budget; <see cref="Timeout.InfiniteTimeSpan"/> for none.</param>
    /// <returns>The child context; dispose it when its scope ends.</returns>
    public Context WithTimeout(TimeSpan timeout)
    {
        var child = WithCancel();
        child.source!.CancelAfter(timeout);
        return child;
    }

    /// <summary>Derives a cancellation-immune child for cleanup that must run during an unwind (ADR-0174 D7).</summary>
    /// <returns>A context whose token never cancels and whose <see cref="Parent"/> is this context.</returns>
    public Context Shielded() => new(CancellationToken.None, source: null, parent: this, isShielded: true);

    /// <summary>
    /// Derives a cancellation-immune child with a bounded grace budget
    /// (ADR-0174 D7). Cleanup running under it does not observe the outer
    /// cancellation, but it does not get to run forever either: when the budget
    /// expires the context cancels, the abandoned cleanup unwinds, and
    /// <see cref="GsharpRuntime.DeferGraceExpired"/> reports it. An infinite
    /// budget is an unbounded shield.
    /// </summary>
    /// <param name="grace">How long the shielded body may run; <see cref="Timeout.InfiniteTimeSpan"/> for no deadline.</param>
    /// <returns>A shielded context whose <see cref="Parent"/> is this context.</returns>
    public Context Shielded(TimeSpan grace)
    {
        if (grace == Timeout.InfiniteTimeSpan)
        {
            return Shielded();
        }

        var budget = new CancellationTokenSource();
        var shielded = new Context(budget.Token, budget, parent: this, isShielded: true);
        shielded.graceBudget = grace;
        budget.Token.Register(static state => GsharpRuntime.RaiseDeferGraceExpired(((Context)state!).graceBudget), shielded);
        budget.CancelAfter(grace);
        return shielded;
    }

    /// <summary>Requests cancellation of this context and every descendant, when this context owns its cancellation.</summary>
    /// <returns><see langword="true"/> when a cancellation was requested; <see langword="false"/> for <see cref="None"/>, a foreign-token wrapper, a shielded context, or a disposed one.</returns>
    public bool TryCancel()
    {
        if (source == null)
        {
            return false;
        }

        try
        {
            source.Cancel();
            return true;
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
    }

    /// <summary>Throws <see cref="OperationCanceledException"/> when cancellation has been requested.</summary>
    public void ThrowIfCancelled() => Token.ThrowIfCancellationRequested();

    /// <summary>Releases the owned cancellation source, if any. Descendants already derived keep their own sources.</summary>
    public void Dispose() => source?.Dispose();

    /// <inheritdoc/>
    public override string ToString()
        => ReferenceEquals(this, None) ? "Context.None"
            : IsShielded ? "Context(shielded)"
            : IsCancelled ? "Context(cancelled)"
            : "Context";
}
