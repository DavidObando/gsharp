// <copyright file="GoroutineRuntime.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// Process-wide goroutine bookkeeping (ADR-0174 D5): the sink for goroutines
/// started outside any <c>scope</c>, the hook a host uses to observe or
/// override their failures, and a live count for diagnostics.
/// </summary>
/// <remarks>
/// A free goroutine is <em>fail-fast</em> by default — an unhandled exception
/// terminates the process, as an unrecovered Go panic does — because a
/// goroutine nobody joins has nowhere else to deliver a failure, and
/// swallowing it would be the wave-1 <c>Task.Run</c> behavior this ADR
/// retires. Subscribing to <see cref="UnhandledGoroutineException"/> and
/// setting <see cref="UnhandledGoroutineExceptionEventArgs.Handled"/> keeps the
/// process alive; the exception is then the host's to log or rethrow.
/// </remarks>
public static class GoroutineRuntime
{
    private static long live;

    /// <summary>Raised on the faulting thread when a free goroutine fails, before the process is terminated.</summary>
    public static event EventHandler<UnhandledGoroutineExceptionEventArgs>? UnhandledGoroutineException;

    /// <summary>Gets the sink for goroutines started outside any <c>scope</c>.</summary>
    public static IGoroutineSink FreeSink { get; } = new FreeGoroutineSink();

    /// <summary>Gets the number of goroutines started and not yet completed. A diagnostic snapshot, racy by nature.</summary>
    public static long LiveGoroutines => Volatile.Read(ref live);

    /// <summary>
    /// Starts a goroutine whose body is <paramref name="body"/>, reporting to
    /// <paramref name="sink"/>: registers before queueing, never lets an exception
    /// escape the pool thread, consumes the body's <see cref="ValueTask"/> exactly
    /// once. This is the delegate-shaped entry the compiler emits until the
    /// synthesized work item derives from <see cref="GoroutineWorkItem"/> directly
    /// (one delegate and one item per spawn; no <see cref="Task"/>).
    /// </summary>
    /// <param name="body">The goroutine body.</param>
    /// <param name="sink">The completion sink; <see langword="null"/> means <see cref="FreeSink"/>.</param>
    public static void Start(Func<ValueTask> body, IGoroutineSink? sink)
    {
        ArgumentNullException.ThrowIfNull(body);
        new DelegateGoroutine(sink ?? FreeSink, body).Start();
    }

    /// <summary>
    /// Erases a goroutine body's result: <c>go f(x)</c> where <c>f</c> yields a
    /// value discards it (ADR-0022), so the synthesized body returns a plain
    /// <see cref="ValueTask"/>. A completed result costs nothing; a pending one
    /// is observed through its task.
    /// </summary>
    /// <typeparam name="T">The discarded result type.</typeparam>
    /// <param name="pending">The body's pending result.</param>
    /// <returns>A task that completes when <paramref name="pending"/> does, faulting the same way.</returns>
    public static ValueTask Discard<T>(ValueTask<T> pending)
    {
        if (pending.IsCompletedSuccessfully)
        {
            _ = pending.Result;
            return ValueTask.CompletedTask;
        }

        return new ValueTask(pending.AsTask());
    }

    /// <summary>Wraps a goroutine body that yields a <see cref="Task"/> (an <c>async func</c> operand).</summary>
    /// <param name="pending">The body's task.</param>
    /// <returns>A <see cref="ValueTask"/> over it.</returns>
    public static ValueTask Wrap(Task pending) => new(pending);

    internal static void OnStarted() => Interlocked.Increment(ref live);

    internal static void OnFinished() => Interlocked.Decrement(ref live);

    /// <summary>Offers <paramref name="exception"/> to the host hook.</summary>
    /// <param name="exception">The free goroutine's failure.</param>
    /// <returns><see langword="true"/> when a subscriber marked it handled.</returns>
    internal static bool TryHandle(Exception exception)
    {
        var handlers = UnhandledGoroutineException;
        if (handlers == null)
        {
            return false;
        }

        var args = new UnhandledGoroutineExceptionEventArgs(exception);
        handlers(null, args);
        return args.Handled;
    }

    private sealed class DelegateGoroutine : GoroutineWorkItem
    {
        private readonly Func<ValueTask> body;

        public DelegateGoroutine(IGoroutineSink sink, Func<ValueTask> body)
            : base(sink)
        {
            this.body = body;
        }

        protected override ValueTask Run() => body();
    }

    private sealed class FreeGoroutineSink : IGoroutineSink
    {
        public Context Context => Context.None;

        public void Register()
        {
        }

        public void Complete()
        {
        }

        public void Fail(Exception exception)
        {
            if (TryHandle(exception))
            {
                return;
            }

            Environment.FailFast(
                "An unhandled exception escaped a free goroutine (one started by `go` outside any `scope`). "
                + "ADR-0174 D5: a free goroutine is fail-fast, like an unrecovered Go panic; run it inside a `scope` to "
                + "have the failure propagate, or handle GoroutineRuntime.UnhandledGoroutineException to observe it.",
                exception);
        }
    }
}
