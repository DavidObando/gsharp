// <copyright file="GoroutineWorkItem.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.CompilerServices;

namespace Gsharp.Concurrency;

/// <summary>
/// The base class of every synthesized goroutine (ADR-0174 D5). <c>go f(args)</c>
/// evaluates <c>f</c> and its arguments on the spawning goroutine, constructs
/// a subclass instance holding them, and calls <see cref="Start"/>, which
/// registers with the <see cref="Sink"/> <em>before</em> queueing the item on
/// the thread pool — no <see cref="Task"/>, no delegate. <see cref="Run"/> is the
/// body; its pooled <see cref="ValueTask"/> is consumed exactly once here, and
/// every outcome — synchronous throw, synchronous completion, asynchronous
/// fault — is routed to the sink. No exception ever escapes
/// <see cref="IThreadPoolWorkItem.Execute"/>.
/// </summary>
public abstract class GoroutineWorkItem : IThreadPoolWorkItem
{
    private ValueTaskAwaiter awaiter;
    private Action? observe;

    /// <summary>Initializes a new instance of the <see cref="GoroutineWorkItem"/> class.</summary>
    /// <param name="sink">The completion sink — the enclosing scope's frame, or <see cref="GoroutineRuntime.FreeSink"/>.</param>
    protected GoroutineWorkItem(IGoroutineSink sink)
    {
        Sink = sink ?? throw new ArgumentNullException(nameof(sink));
    }

    /// <summary>Gets the sink this goroutine reports to.</summary>
    public IGoroutineSink Sink { get; }

    /// <summary>Gets the ambient cancellation context the body runs under.</summary>
    protected Context Context => Sink.Context;

    /// <summary>Registers with the sink, then queues the goroutine. The order is normative: the reverse races a fast child to completion before the scope knows it exists.</summary>
    public void Start()
    {
        Sink.Register();
        GoroutineRuntime.OnStarted();
        ThreadPool.UnsafeQueueUserWorkItem(this, preferLocal: true);
    }

    /// <summary>Runs the body and routes its outcome to the sink. Never throws. The thread pool calls this; a host that schedules goroutines itself may too.</summary>
    public void Execute()
    {
        ValueTask body;
        try
        {
            body = Run();
        }
        catch (Exception exception)
        {
            Finish(exception);
            return;
        }

        awaiter = body.GetAwaiter();
        if (awaiter.IsCompleted)
        {
            Observe();
            return;
        }

        awaiter.UnsafeOnCompleted(observe ??= Observe);
    }

    /// <summary>The goroutine body.</summary>
    /// <returns>The body's completion; consumed exactly once by this class.</returns>
    protected abstract ValueTask Run();

    private void Observe()
    {
        Exception? failure = null;
        try
        {
            awaiter.GetResult();
        }
        catch (Exception exception)
        {
            failure = exception;
        }

        awaiter = default;
        Finish(failure);
    }

    private void Finish(Exception? failure)
    {
        GoroutineRuntime.OnFinished();
        try
        {
            if (failure == null)
            {
                Sink.Complete();
            }
            else
            {
                Sink.Fail(failure);
            }
        }
        catch (Exception sinkFailure)
        {
            // A sink that throws is a runtime defect, not a user failure; it
            // still must not escape Execute. Surface it the way a free
            // goroutine's failure surfaces.
            GoroutineRuntime.FreeSink.Fail(sinkFailure);
        }
    }
}
