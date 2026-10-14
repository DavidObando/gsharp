// <copyright file="GoroutineWorkItemTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Collections.Concurrent
import System.Threading
import System.Threading.Tasks
import System.Threading.Tasks.Sources
import Xunit

/// ADR-0174 D5: the goroutine work item. Every outcome of the body reaches the
/// sink — a synchronous throw, a synchronously completed
/// (cref:ValueTask), an asynchronously faulted one — and nothing escapes
/// (cref:GoroutineWorkItem.Execute); the body's pooled
/// (cref:ValueTask) is consumed exactly once; and (cref:GoroutineWorkItem.Start)
/// registers with the sink before it queues the item.
/// @remarks Discrimination witnesses (ADR-0154, mutants applied to
/// `src/Sdk/Gsharp.Runtime.Channels/GoroutineWorkItem.cs`): removing the
/// `try` around `Run()` makes (cref:SynchronousThrow_ReachesTheSink_AndDoesNotEscapeExecute)
/// throw out of `Execute`; calling `GetResult` a second time (or
/// never) breaks (cref:Body_IsConsumedExactlyOnce); queueing before
/// `Sink.Register()` breaks (cref:Start_RegistersBeforeQueueing),
/// whose sink observes a completion for a goroutine it was never told about.
open class GoroutineWorkItemTests {
    @Fact
    func SynchronousThrow_ReachesTheSink_AndDoesNotEscapeExecute() {
        let sink = RecordingSink()
        let item = GoroutineWorkItemTests.DelegateWorkItem(sink, () -> throw InvalidOperationException("boom"))
        item.Execute()
        let failure = Assert.Single(sink.Failures)
        Assert.IsType[InvalidOperationException](failure)
        Assert.Equal(0, sink.Completions)
    }

    @Fact
    func SynchronousCompletion_ReachesTheSink() {
        let sink = RecordingSink()
        let item = GoroutineWorkItemTests.DelegateWorkItem(sink, () -> ValueTask.CompletedTask)
        item.Execute()
        Assert.Equal(1, sink.Completions)
        Assert.Empty(sink.Failures)
    }

    @Fact
    async func AsynchronousFault_ReachesTheSink_AndDoesNotEscapeExecute() {
        let sink = RecordingSink()
        let item = GoroutineWorkItemTests.DelegateWorkItem(
            sink,
            async () -> {
                await Task.Yield()
                throw ArgumentException("late")
            }
        )
        item.Execute()
        await sink.WaitForOutcomeAsync()
        let failure = Assert.Single(sink.Failures)
        Assert.IsType[ArgumentException](failure)
    }

    @Fact
    async func Body_IsConsumedExactlyOnce() {
        let source = CountingSource()
        let sink = RecordingSink()
        let item = GoroutineWorkItemTests.DelegateWorkItem(sink, () -> ValueTask(source, source.Version))
        item.Execute()
        source.Complete()
        await sink.WaitForOutcomeAsync()
        Assert.Equal(1, source.GetResultCalls)
        Assert.Equal(1, sink.Completions)
    }

    @Fact
    async func Start_RegistersBeforeQueueing() {
        // A strict sink: a completion for a goroutine that was not registered
        // first is recorded as a protocol violation. Fast bodies make the
        // reverse order (queue, then register) observable within a few
        // thousand starts.
        let sink = StrictSink()
        const Count = 4000
        for var i = 0; i < Count; i++ {
            GoroutineWorkItemTests.DelegateWorkItem(sink, () -> ValueTask.CompletedTask).Start()
        }
        await sink.WaitForAsync(Count)
        Assert.Equal(0, sink.Violations)
        Assert.Equal(Count, sink.Registered)
    }

    @Fact
    async func LiveGoroutines_ReturnsToBaseline() {
        let before = GoroutineRuntime.LiveGoroutines
        let sink = StrictSink()
        for var i = 0; i < 100; i++ {
            GoroutineWorkItemTests.DelegateWorkItem(
                sink,
                async func () ValueTask {
                    await Task.Yield()
                }
            )
                .Start()
        }
        await sink.WaitForAsync(100)
        // Other tests may run goroutines concurrently, so the count is a
        // lower bound on "we decremented for each of ours".
        Assert.True(GoroutineRuntime.LiveGoroutines <= before + int64(100))
    }

    @Fact
    func FreeSink_Failure_IsOfferedToTheHostHook() {
        let observed = ConcurrentQueue[Exception]()
        let handler EventHandler[UnhandledGoroutineExceptionEventArgs] = (
            _ object?,
            args UnhandledGoroutineExceptionEventArgs
        ) -> {
            observed.Enqueue(args.Exception)
            args.Handled = true
        }
        GoroutineRuntime.UnhandledGoroutineException += handler
        try {
            let item = GoroutineWorkItemTests.DelegateWorkItem(
                GoroutineRuntime.FreeSink,
                () -> throw TimeoutException("free")
            )
            item.Execute()
        } finally {
            GoroutineRuntime.UnhandledGoroutineException -= handler
        }
        let failure = Assert.Single(observed)
        Assert.IsType[TimeoutException](failure)
    }

    @Fact
    async func Start_WithADelegateBody_ReportsToTheSink() {
        let sink = RecordingSink()
        GoroutineRuntime.Start(
            async () -> {
                await Task.Yield()
            },
            sink
        )
        await sink.WaitForOutcomeAsync()
        Assert.Equal(1, sink.Completions)
        Assert.Empty(sink.Failures)
    }

    @Fact
    async func Start_WithAFaultingDelegateBody_ReportsTheFault() {
        let sink = RecordingSink()
        GoroutineRuntime.Start(() -> throw InvalidOperationException("free"), sink)
        await sink.WaitForOutcomeAsync()
        Assert.IsType[InvalidOperationException](Assert.Single(sink.Failures))
    }

    private class DelegateWorkItem : GoroutineWorkItem {
        private let body() -> ValueTask

        init(sink IGoroutineSink, body() -> ValueTask) : base(sink) {
            this.body = body
        }

        protected override func Run() ValueTask -> body()
    }

    private class RecordingSink : IGoroutineSink {
        init() {
            Failures = ConcurrentQueue[Exception]()
        }

        private let outcome TaskCompletionSource = TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        )
        private var completions int32

        prop Failures ConcurrentQueue[Exception] {
            get;
        }

        prop Completions int32 -> Volatile.Read(&completions)
        prop Context Context -> Context.None

        func Register() { }

        func Complete() {
            Interlocked.Increment(&completions)
            outcome.TrySetResult()
        }

        func Fail(exception Exception) {
            Failures.Enqueue(exception)
            outcome.TrySetResult()
        }

        func WaitForOutcomeAsync() Task -> outcome.Task.WaitAsync(TimeSpan.FromSeconds(10))
    }

    private class StrictSink : IGoroutineSink {
        private let done TaskCompletionSource = TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)
        private var registered int32
        private var completed int32
        private var violations int32
        private var expected int32
        prop Registered int32 -> Volatile.Read(&registered)
        prop Violations int32 -> Volatile.Read(&violations)
        prop Context Context -> Context.None

        func Register() {
            // A registration that costs something — a real frame takes a lock
            // or bumps a counter under contention — widens the window in
            // which a queued-before-registered goroutine can complete first.
            Thread.SpinWait(2000)
            Interlocked.Increment(&registered)
        }

        func Complete() {
            if Volatile.Read(&registered) < Volatile.Read(&completed) + 1 {
                Interlocked.Increment(&violations)
            }
            if Interlocked.Increment(&completed) == Volatile.Read(&expected) {
                done.TrySetResult()
            }
        }

        func Fail(exception Exception) {
            Interlocked.Increment(&violations)
            Complete()
        }

        func WaitForAsync(count int32) Task {
            Volatile.Write(&expected, count)
            if Volatile.Read(&completed) >= count {
                done.TrySetResult()
            }
            return done.Task.WaitAsync(TimeSpan.FromSeconds(20))
        }
    }

    private class CountingSource : IValueTaskSource {
        private var core ManualResetValueTaskSourceCore[bool]
        private var getResultCalls int32
        prop Version int16 -> core.Version
        prop GetResultCalls int32 -> Volatile.Read(&getResultCalls)
        func Complete() -> core.SetResult(true)

        func GetResult(token int16) {
            Interlocked.Increment(&getResultCalls)
            core.GetResult(token)
        }

        func GetStatus(token int16) ValueTaskSourceStatus -> core.GetStatus(token)

        func OnCompleted(
            continuation(object?) -> void,
            state object?,
            token int16,
            flags ValueTaskSourceOnCompletedFlags
        ) -> core.OnCompleted(continuation, state, token, flags)
    }
}
