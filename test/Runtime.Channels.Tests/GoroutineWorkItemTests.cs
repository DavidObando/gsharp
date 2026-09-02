// <copyright file="GoroutineWorkItemTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using System.Threading.Tasks.Sources;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D5: the goroutine work item. Every outcome of the body reaches the
/// sink — a synchronous throw, a synchronously completed
/// <see cref="ValueTask"/>, an asynchronously faulted one — and nothing escapes
/// <see cref="GoroutineWorkItem.Execute"/>; the body's pooled
/// <see cref="ValueTask"/> is consumed exactly once; and <see cref="GoroutineWorkItem.Start"/>
/// registers with the sink before it queues the item.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154, mutants applied to
/// <c>src/Sdk/Gsharp.Runtime.Channels/GoroutineWorkItem.cs</c>): removing the
/// <c>try</c> around <c>Run()</c> makes <see cref="SynchronousThrow_ReachesTheSink_AndDoesNotEscapeExecute"/>
/// throw out of <c>Execute</c>; calling <c>GetResult</c> a second time (or
/// never) breaks <see cref="Body_IsConsumedExactlyOnce"/>; queueing before
/// <c>Sink.Register()</c> breaks <see cref="Start_RegistersBeforeQueueing"/>,
/// whose sink observes a completion for a goroutine it was never told about.
/// </remarks>
public class GoroutineWorkItemTests
{
    [Fact]
    public void SynchronousThrow_ReachesTheSink_AndDoesNotEscapeExecute()
    {
        var sink = new RecordingSink();
        var item = new DelegateWorkItem(sink, () => throw new InvalidOperationException("boom"));

        item.Execute();

        var failure = Assert.Single(sink.Failures);
        Assert.IsType<InvalidOperationException>(failure);
        Assert.Equal(0, sink.Completions);
    }

    [Fact]
    public void SynchronousCompletion_ReachesTheSink()
    {
        var sink = new RecordingSink();
        var item = new DelegateWorkItem(sink, () => ValueTask.CompletedTask);

        item.Execute();

        Assert.Equal(1, sink.Completions);
        Assert.Empty(sink.Failures);
    }

    [Fact]
    public async Task AsynchronousFault_ReachesTheSink_AndDoesNotEscapeExecute()
    {
        var sink = new RecordingSink();
        var item = new DelegateWorkItem(sink, async () =>
        {
            await Task.Yield();
            throw new ArgumentException("late");
        });

        item.Execute();
        await sink.WaitForOutcomeAsync();

        var failure = Assert.Single(sink.Failures);
        Assert.IsType<ArgumentException>(failure);
    }

    [Fact]
    public async Task Body_IsConsumedExactlyOnce()
    {
        var source = new CountingSource();
        var sink = new RecordingSink();
        var item = new DelegateWorkItem(sink, () => new ValueTask(source, source.Version));

        item.Execute();
        source.Complete();
        await sink.WaitForOutcomeAsync();

        Assert.Equal(1, source.GetResultCalls);
        Assert.Equal(1, sink.Completions);
    }

    [Fact]
    public async Task Start_RegistersBeforeQueueing()
    {
        // A strict sink: a completion for a goroutine that was not registered
        // first is recorded as a protocol violation. Fast bodies make the
        // reverse order (queue, then register) observable within a few
        // thousand starts.
        var sink = new StrictSink();
        const int Count = 4000;
        for (var i = 0; i < Count; i++)
        {
            new DelegateWorkItem(sink, () => ValueTask.CompletedTask).Start();
        }

        await sink.WaitForAsync(Count);

        Assert.Equal(0, sink.Violations);
        Assert.Equal(Count, sink.Registered);
    }

    [Fact]
    public async Task LiveGoroutines_ReturnsToBaseline()
    {
        var before = GoroutineRuntime.LiveGoroutines;
        var sink = new StrictSink();
        for (var i = 0; i < 100; i++)
        {
            new DelegateWorkItem(sink, async () => await Task.Yield()).Start();
        }

        await sink.WaitForAsync(100);

        // Other tests may run goroutines concurrently, so the count is a
        // lower bound on "we decremented for each of ours".
        Assert.True(GoroutineRuntime.LiveGoroutines <= before + 100);
    }

    [Fact]
    public void FreeSink_Failure_IsOfferedToTheHostHook()
    {
        var observed = new ConcurrentQueue<Exception>();
        EventHandler<UnhandledGoroutineExceptionEventArgs> handler = (_, args) =>
        {
            observed.Enqueue(args.Exception);
            args.Handled = true;
        };
        GoroutineRuntime.UnhandledGoroutineException += handler;
        try
        {
            var item = new DelegateWorkItem(GoroutineRuntime.FreeSink, () => throw new TimeoutException("free"));
            item.Execute();
        }
        finally
        {
            GoroutineRuntime.UnhandledGoroutineException -= handler;
        }

        var failure = Assert.Single(observed);
        Assert.IsType<TimeoutException>(failure);
    }

    [Fact]
    public async Task Start_WithADelegateBody_ReportsToTheSink()
    {
        var sink = new RecordingSink();
        GoroutineRuntime.Start(async () =>
        {
            await Task.Yield();
        }, sink);

        await sink.WaitForOutcomeAsync();

        Assert.Equal(1, sink.Completions);
        Assert.Empty(sink.Failures);
    }

    [Fact]
    public async Task Start_WithAFaultingDelegateBody_ReportsTheFault()
    {
        var sink = new RecordingSink();
        GoroutineRuntime.Start(() => throw new InvalidOperationException("free"), sink);

        await sink.WaitForOutcomeAsync();

        Assert.IsType<InvalidOperationException>(Assert.Single(sink.Failures));
    }

    private sealed class DelegateWorkItem : GoroutineWorkItem
    {
        private readonly Func<ValueTask> body;

        public DelegateWorkItem(IGoroutineSink sink, Func<ValueTask> body)
            : base(sink)
        {
            this.body = body;
        }

        protected override ValueTask Run() => body();
    }

    private sealed class RecordingSink : IGoroutineSink
    {
        private readonly TaskCompletionSource outcome = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int completions;

        public ConcurrentQueue<Exception> Failures { get; } = new();

        public int Completions => Volatile.Read(ref completions);

        public Context Context => Context.None;

        public void Register()
        {
        }

        public void Complete()
        {
            Interlocked.Increment(ref completions);
            outcome.TrySetResult();
        }

        public void Fail(Exception exception)
        {
            Failures.Enqueue(exception);
            outcome.TrySetResult();
        }

        public Task WaitForOutcomeAsync() => outcome.Task.WaitAsync(TimeSpan.FromSeconds(10));
    }

    private sealed class StrictSink : IGoroutineSink
    {
        private readonly TaskCompletionSource done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int registered;
        private int completed;
        private int violations;
        private int expected;

        public int Registered => Volatile.Read(ref registered);

        public int Violations => Volatile.Read(ref violations);

        public Context Context => Context.None;

        public void Register()
        {
            // A registration that costs something — a real frame takes a lock
            // or bumps a counter under contention — widens the window in
            // which a queued-before-registered goroutine can complete first.
            Thread.SpinWait(2000);
            Interlocked.Increment(ref registered);
        }

        public void Complete()
        {
            if (Volatile.Read(ref registered) < Volatile.Read(ref completed) + 1)
            {
                Interlocked.Increment(ref violations);
            }

            if (Interlocked.Increment(ref completed) == Volatile.Read(ref expected))
            {
                done.TrySetResult();
            }
        }

        public void Fail(Exception exception)
        {
            Interlocked.Increment(ref violations);
            Complete();
        }

        public Task WaitForAsync(int count)
        {
            Volatile.Write(ref expected, count);
            if (Volatile.Read(ref completed) >= count)
            {
                done.TrySetResult();
            }

            return done.Task.WaitAsync(TimeSpan.FromSeconds(20));
        }
    }

    private sealed class CountingSource : IValueTaskSource
    {
        private ManualResetValueTaskSourceCore<bool> core;
        private int getResultCalls;

        public short Version => core.Version;

        public int GetResultCalls => Volatile.Read(ref getResultCalls);

        public void Complete() => core.SetResult(true);

        public void GetResult(short token)
        {
            Interlocked.Increment(ref getResultCalls);
            core.GetResult(token);
        }

        public ValueTaskSourceStatus GetStatus(short token) => core.GetStatus(token);

        public void OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
            => core.OnCompleted(continuation, state, token, flags);
    }
}
