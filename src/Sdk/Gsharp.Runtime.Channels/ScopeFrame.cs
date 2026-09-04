// <copyright file="ScopeFrame.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.ExceptionServices;

namespace Gsharp.Concurrency;

/// <summary>
/// The runtime half of a <c>scope { … }</c> block (ADR-0174 D6): the sink its
/// goroutines report to, the owner of the block's <see cref="Context"/>, and
/// the join at exit. The pending count starts at one for the body itself;
/// every <see cref="Register"/> adds one, every <see cref="Complete"/> or
/// <see cref="Fail"/> removes one, and <see cref="ExitAsync"/> retires the
/// body's own count and waits for zero. The first failure cancels the frame's
/// context <em>inside</em> <see cref="Fail"/> — siblings parked on a channel
/// unwind promptly, before the join, not after.
/// </summary>
/// <remarks>
/// <para>Exit precedence, from the ADR's table: a failing body with healthy
/// children rethrows the body's exception unwrapped; failing children raise a
/// <see cref="ScopeException"/> in completion order; when both fail the body's
/// exception is at index 0; cancellation arriving from the <em>outer</em>
/// context alone rethrows the <see cref="OperationCanceledException"/>; and
/// cancellation the frame inflicted on itself (a child failed) reports the
/// causing failure and discards the siblings' cancellations.</para>
/// <para>The frame is a <see cref="TaskCompletionSource"/> and an interlocked
/// counter — one allocation per scope. Pooling it behind an
/// <c>IValueTaskSource</c> is a Phase 5 refinement, gated on the concurrency
/// benchmark showing the allocation matters (ADR-0174 errata).</para>
/// <para>A join that outlives <see cref="GsharpRuntime.ScopeStallTimeout"/>
/// raises <see cref="GsharpRuntime.ScopeStalled"/> and keeps waiting: a scope
/// that promised to join keeps its promise, and the hook exists so a host can
/// see a goroutine that never completes.</para>
/// </remarks>
public sealed class ScopeFrame : IGoroutineSink
{
    private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Context ambient;
    private readonly object gate = new();
    private List<Exception>? failures;
    private int pending = 1;

    private ScopeFrame(Context ambient)
    {
        this.ambient = ambient;
        Context = ambient.WithCancel();
    }

    /// <summary>Gets the block's own context: cancelled by the first child failure or by the ambient context.</summary>
    public Context Context { get; }

    /// <summary>Gets the number of registrations not yet completed, including the body's own until exit. A diagnostic snapshot.</summary>
    public int Pending => Volatile.Read(ref pending);

    /// <summary>Enters a scope under <paramref name="ambient"/>.</summary>
    /// <param name="ambient">The enclosing context; <see langword="null"/> means <see cref="Context.None"/>.</param>
    /// <returns>The frame; call <see cref="ExitAsync"/> (or <see cref="Exit"/> at a root) exactly once.</returns>
    public static ScopeFrame Enter(Context? ambient) => new(ambient ?? Context.None);

    /// <inheritdoc/>
    public void Register() => Interlocked.Increment(ref pending);

    /// <inheritdoc/>
    public void Complete()
    {
        var remaining = Interlocked.Decrement(ref pending);
        if (remaining == 0)
        {
            completion.TrySetResult();
        }
        else if (remaining < 0)
        {
            throw new InvalidOperationException("A scope frame completed more goroutines than were registered (ADR-0174 D5: Register must precede queueing).");
        }
    }

    /// <inheritdoc/>
    public void Fail(Exception exception)
    {
        RecordFailure(exception);
        Complete();
    }

    /// <summary>Retires the body's registration, joins every goroutine, releases the context, and throws per the exit precedence table.</summary>
    /// <param name="bodyException">The exception the block body threw, or <see langword="null"/>.</param>
    /// <returns>A task that completes when every goroutine has completed.</returns>
    public async ValueTask ExitAsync(Exception? bodyException = null)
    {
        Complete();
        await JoinAsync().ConfigureAwait(false);
        Context.Dispose();
        var exception = BuildExitException(bodyException);
        if (exception != null)
        {
            ExceptionDispatchInfo.Throw(exception);
        }
    }

    /// <summary>
    /// Folds a child's failure into this scope without touching the pending
    /// count. An <c>async let</c> cell retires its own registration when the
    /// child completes, because the failure belongs to whoever reads the
    /// binding; when nobody does, the cell hands it back here at scope exit
    /// (ADR-0174 D15).
    /// </summary>
    /// <param name="exception">The child's exception, unwrapped.</param>
    public void RecordChildFailure(Exception exception) => RecordFailure(exception);

    /// <summary>The blocking form of <see cref="ExitAsync"/>, for the synthesized root that may block (ADR-0174 D4).</summary>
    /// <param name="bodyException">The exception the block body threw, or <see langword="null"/>.</param>
    public void Exit(Exception? bodyException = null) => ExitAsync(bodyException).AsTask().GetAwaiter().GetResult();

    // Waits for every registration, reporting a stall through the runtime hook
    // if the join outlives GsharpRuntime.ScopeStallTimeout (ADR-0174 D6: the
    // documented partial mitigation for a goroutine that never completes). The
    // join is never abandoned — a scope that promised to join keeps its promise.
    private async ValueTask JoinAsync()
    {
        var stallTimeout = GsharpRuntime.ScopeStallTimeout;
        if (stallTimeout == Timeout.InfiniteTimeSpan || completion.Task.IsCompleted)
        {
            await completion.Task.ConfigureAwait(false);
            return;
        }

        var waited = TimeSpan.Zero;
        while (true)
        {
            var stall = Task.Delay(stallTimeout);
            var finished = await Task.WhenAny(completion.Task, stall).ConfigureAwait(false);
            if (ReferenceEquals(finished, completion.Task))
            {
                await completion.Task.ConfigureAwait(false);
                return;
            }

            waited += stallTimeout;
            GsharpRuntime.RaiseScopeStalled(waited, Pending);
        }
    }

    private void RecordFailure(Exception exception)
    {
        lock (gate)
        {
            (failures ??= new List<Exception>()).Add(exception);
        }

        // Prompt sibling cancellation: inside the failure path, before the join.
        Context.TryCancel();
    }

    private Exception? BuildExitException(Exception? bodyException)
    {
        List<Exception>? children;
        lock (gate)
        {
            children = failures;
            failures = null;
        }

        var bodyCancelledOnly = bodyException is OperationCanceledException;
        if (children == null || children.Count == 0)
        {
            return bodyException;
        }

        var real = children.FindAll(static e => e is not OperationCanceledException);
        if (bodyException != null && !bodyCancelledOnly)
        {
            var all = new List<Exception>(1 + real.Count) { bodyException };
            all.AddRange(real.Count > 0 ? real : children);
            return new ScopeException(all);
        }

        if (real.Count > 0)
        {
            // Self-inflicted cancellation: the causing failure leads, and the
            // siblings' (and the body's) OperationCanceledExceptions are noise.
            return new ScopeException(real);
        }

        // Only cancellations. From the outer context they are not a failure;
        // a child that cancelled itself with nothing else failing is reported.
        return ambient.IsCancelled ? (bodyException ?? children[0]) : new ScopeException(children);
    }
}
