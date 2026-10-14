// <copyright file="ScopeFrameTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0174 D6: the scope frame's join and its exit precedence table, one fact
/// per row, plus the two ordering rules — registration before queueing and
/// prompt sibling cancellation inside the failure path.
/// @remarks Discrimination witnesses (ADR-0154, mutants applied to
/// `src/Sdk/Gsharp.Runtime.Channels/ScopeFrame.cs`): moving
/// `Context.TryCancel()` out of `RecordFailure` and into exit breaks
/// (cref:Exit_ChildFailure_CancelsSiblingsBeforeExitCompletes) (the
/// sibling parks forever and the test times out); wrapping a lone body
/// exception in a (cref:ScopeException) breaks
/// (cref:Exit_BodyThrows_ChildrenSucceed_RethrowsBodyUnwrapped);
/// listing sibling cancellations breaks
/// (cref:Exit_SelfInflictedCancellation_DiscardsSiblingCancellations).
open class ScopeFrameTests {
    @Fact
    async func Exit_NoFailures_CompletesQuietly() {
        let frame = ScopeFrame.Enter(Context.None)
        Spawn(
            frame,
            async func () ValueTask {
                await Task.Yield()
            }
        )
        Spawn(frame, () -> ValueTask.CompletedTask)
        await frame.ExitAsync()
        Assert.Equal(0, frame.Pending)
    }

    @Fact
    async func Exit_BodyThrows_ChildrenSucceed_RethrowsBodyUnwrapped() {
        let frame = ScopeFrame.Enter(Context.None)
        Spawn(frame, () -> ValueTask.CompletedTask)
        let body = InvalidOperationException("body")
        let thrown = await Assert.ThrowsAsync[InvalidOperationException](
            async () -> {
                await frame.ExitAsync(body)
            }
        )
        Assert.Same(body, thrown)
    }

    @Fact
    async func Exit_ChildrenFail_BodySucceeds_ThrowsScopeException_InCompletionOrder() {
        let frame = ScopeFrame.Enter(Context.None)
        let first = InvalidOperationException("first")
        let second = ArgumentException("second")
        frame.Register()
        frame.Register()
        frame.Fail(first)
        frame.Fail(second)
        let thrown = await Assert.ThrowsAsync[ScopeException](
            async () -> {
                await frame.ExitAsync()
            }
        )
        Assert.Same(first, thrown.FirstFailure)
        Assert.Same(first, thrown.InnerException)
        Assert.Equal([]Exception{first, second}, thrown.InnerExceptions)
    }

    @Fact
    async func Exit_BothFail_BodyAtIndexZero() {
        let frame = ScopeFrame.Enter(Context.None)
        let child = InvalidOperationException("child")
        frame.Register()
        frame.Fail(child)
        let body = ArgumentException("body")
        let thrown = await Assert.ThrowsAsync[ScopeException](
            async () -> {
                await frame.ExitAsync(body)
            }
        )
        Assert.Same(body, thrown.FirstFailure)
        Assert.Equal([]Exception{body, child}, thrown.InnerExceptions)
    }

    @Fact
    async func Exit_OuterCancellationOnly_ThrowsOperationCanceled() {
        using let outer = Context.None.WithCancel()
        let frame = ScopeFrame.Enter(outer)
        let parked = TaskCompletionSource()
        Spawn(
            frame,
            async () -> {
                await parked.Task
                frame.Context.ThrowIfCancelled()
            }
        )
        outer.TryCancel()
        parked.SetResult()
        await Assert.ThrowsAsync[OperationCanceledException](
            async () -> {
                await frame.ExitAsync()
            }
        )
    }

    @Fact
    async func Exit_ChildFailure_CancelsSiblingsBeforeExitCompletes() {
        let frame = ScopeFrame.Enter(Context.None)
        let siblingUnparked = TaskCompletionSource()
        Spawn(
            frame,
            async () -> {
                // Parks until the frame's context is cancelled — which only the
                // sibling's failure can do. If cancellation waited for the join,
                // this goroutine would never complete and the join would hang.
                let tcs = TaskCompletionSource()
                using let registration = frame.Context.Token.Register(() -> tcs.TrySetResult())
                await tcs.Task
                siblingUnparked.TrySetResult()
                frame.Context.ThrowIfCancelled()
            }
        )
        Spawn(frame, () -> throw InvalidOperationException("cause"))
        let thrown = await Assert.ThrowsAsync[ScopeException](
            async () -> {
                await frame.ExitAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10))
            }
        )
        Assert.True(siblingUnparked.Task.IsCompleted)
        Assert.IsType[InvalidOperationException](thrown.FirstFailure)
    }

    @Fact
    async func Exit_SelfInflictedCancellation_DiscardsSiblingCancellations() {
        let frame = ScopeFrame.Enter(Context.None)
        let cause = InvalidOperationException("cause")
        frame.Register()
        frame.Register()
        frame.Register()
        frame.Fail(cause)
        frame.Fail(OperationCanceledException(frame.Context.Token))
        frame.Fail(OperationCanceledException(frame.Context.Token))
        let thrown = await Assert.ThrowsAsync[ScopeException](
            async () -> {
                await frame.ExitAsync()
            }
        )
        Assert.Same(cause, Assert.Single(thrown.InnerExceptions))
    }

    @Fact
    async func Exit_BodyCancelledByChildFailure_ReportsTheCause() {
        let frame = ScopeFrame.Enter(Context.None)
        let cause = InvalidOperationException("cause")
        frame.Register()
        frame.Fail(cause)
        let thrown = await Assert.ThrowsAsync[ScopeException](
            async () -> {
                await frame.ExitAsync(OperationCanceledException(frame.Context.Token))
            }
        )
        Assert.Same(cause, Assert.Single(thrown.InnerExceptions))
    }

    @Fact
    func Register_BeforeQueue_FastChildCannotUnderflow() {
        let frame = ScopeFrame.Enter(Context.None)
        for var i = 0; i < 2000; i++ {
            Spawn(frame, () -> ValueTask.CompletedTask)
        }
        frame.Exit()
        Assert.Equal(0, frame.Pending)
    }

    @Fact
    func Complete_MoreThanRegistered_Throws() {
        let frame = ScopeFrame.Enter(Context.None)
        frame.Complete()
        Assert.Throws[InvalidOperationException](() -> frame.Complete())
    }

    @Fact
    async func Exit_DisposesTheContext() {
        let frame = ScopeFrame.Enter(Context.None)
        await frame.ExitAsync()
        Assert.False(frame.Context.TryCancel())
    }

    private class DelegateWorkItem : GoroutineWorkItem {
        private let body() -> ValueTask

        init(sink IGoroutineSink, body() -> ValueTask) : base(sink) {
            this.body = body
        }

        protected override func Run() ValueTask -> body()
    }

    shared {
        private func Spawn(frame ScopeFrame, body() -> ValueTask) -> ScopeFrameTests.DelegateWorkItem(frame, body)
            .Start()
    }
}
