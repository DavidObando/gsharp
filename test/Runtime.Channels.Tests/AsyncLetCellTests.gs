// <copyright file="AsyncLetCellTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0174 D15: the cell behind an `async let`. It is a child of the
/// enclosing scope frame, deposits its value exactly once, retires the frame's
/// registration exactly once whichever path gets there first, and — when
/// nobody reads the binding — cancels its child at scope exit and hands any
/// failure back to the scope rather than dropping it.
/// @remarks Discrimination witnesses (ADR-0154, mutants applied to
/// `src/Sdk/Gsharp.Runtime.Channels/AsyncLetCell.cs`): making
/// `Register` a no-op breaks
/// (cref:Register_AndComplete_LeaveTheFrameBalanced) — the frame's
/// pending count underflows and its exit throws; retiring the frame on every
/// completion path instead of once breaks the same test for the same reason;
/// dropping the `RecordChildFailure` hand-back breaks
/// (cref:UnreadFailure_IsHandedBackToTheScope), where the scope then
/// exits cleanly and the failure is lost; and cancelling the frame's context
/// rather than the cell's own breaks
/// (cref:CancelIfUnread_CancelsOnlyItsOwnChild).
open class AsyncLetCellTests {
    @Fact
    async func Register_AndComplete_LeaveTheFrameBalanced() {
        let frame = ScopeFrame.Enter(nil)
        let cell = AsyncLetCell.Start(frame)
        cell.Register()
        Assert.Equal(2, frame.Pending)
        await cell.Run(7)
        // The work item calls Complete() after the body's ValueTask is
        // consumed; the deposit already retired the registration.
        cell.Complete()
        Assert.Equal(1, frame.Pending)
        Assert.Equal(7, await cell.AwaitAsync[int32]().AsTask().WaitAsync(AsyncLetCellTests.Timeout))
        await frame.ExitAsync()
    }

    @Fact
    async func ReadTwice_ReturnsTheSameValue() {
        let frame = ScopeFrame.Enter(nil)
        let cell = AsyncLetCell.Start(frame)
        cell.Register()
        await cell.Run(ValueTask[string]("hello"))
        Assert.Equal("hello", await cell.AwaitAsync[string]())
        Assert.Equal("hello", await cell.AwaitAsync[string]())
        Assert.True(cell.WasRead)
        await frame.ExitAsync()
    }

    @Fact
    async func AFailure_SurfacesAtTheRead_AndNotAtTheScope() {
        let frame = ScopeFrame.Enter(nil)
        let cell = AsyncLetCell.Start(frame)
        cell.Register()
        cell.Fail(InvalidOperationException("child failed"))
        let read = await Assert.ThrowsAsync[InvalidOperationException](async () -> await cell.AwaitAsync[int32]())
        Assert.Equal("child failed", read.Message)
        // The reader saw it, so the scope exits cleanly.
        await cell.CancelIfUnreadAsync()
        await frame.ExitAsync()
    }

    @Fact
    async func UnreadFailure_IsHandedBackToTheScope() {
        let frame = ScopeFrame.Enter(nil)
        let cell = AsyncLetCell.Start(frame)
        cell.Register()
        cell.Fail(InvalidOperationException("child failed"))
        await cell.CancelIfUnreadAsync()
        let scoped_ = await Assert.ThrowsAsync[ScopeException](
            async () -> {
                await frame.ExitAsync()
            }
        )
        Assert.Contains(scoped_.InnerExceptions, (e Exception) -> e.Message == "child failed")
    }

    @Fact
    async func AFailingChild_DoesNotCancelTheScope() {
        // Swift's rule: catching one `async let` must not kill the ones running
        // beside it, so the cell does not cancel the frame's context.
        let frame = ScopeFrame.Enter(nil)
        let cell = AsyncLetCell.Start(frame)
        cell.Register()
        cell.Fail(InvalidOperationException("child failed"))
        Assert.False(frame.Context.IsCancelled)
        await Assert.ThrowsAsync[InvalidOperationException](async () -> await cell.AwaitAsync[int32]())
        await frame.ExitAsync()
    }

    @Fact
    async func CancelIfUnread_CancelsOnlyItsOwnChild() {
        let frame = ScopeFrame.Enter(nil)
        let unread = AsyncLetCell.Start(frame)
        let other = AsyncLetCell.Start(frame)
        unread.Register()
        other.Register()
        let parked = TaskCompletionSource()
        using let registration = unread.Context.Token.Register(() -> parked.TrySetResult())
        let join = unread.CancelIfUnreadAsync().AsTask()
        await parked.Task.WaitAsync(AsyncLetCellTests.Timeout)
        Assert.True(unread.Context.IsCancelled)
        Assert.False(other.Context.IsCancelled)
        Assert.False(frame.Context.IsCancelled)
        // The child observes the cancellation and reports it.
        unread.Fail(OperationCanceledException(unread.Context.Token))
        await join.WaitAsync(AsyncLetCellTests.Timeout)
        other.Complete()
        await frame.ExitAsync()
    }

    @Fact
    async func CancelIfUnread_OnAReadBinding_DoesNothing() {
        let frame = ScopeFrame.Enter(nil)
        let cell = AsyncLetCell.Start(frame)
        cell.Register()
        await cell.Run(3)
        Assert.Equal(3, await cell.AwaitAsync[int32]())
        await cell.CancelIfUnreadAsync().AsTask().WaitAsync(AsyncLetCellTests.Timeout)
        await frame.ExitAsync()
    }

    @Fact
    async func TheChildsContext_IsLinkedToTheScopes() {
        let frame = ScopeFrame.Enter(nil)
        let cell = AsyncLetCell.Start(frame)
        Assert.Same(frame.Context, cell.Context.Parent)
        frame.Context.TryCancel()
        Assert.True(cell.Context.IsCancelled)
        cell.Register()
        cell.Complete()
        await frame.ExitAsync()
    }

    @Fact
    func Start_WithoutAFrame_Throws() -> Assert.Throws[ArgumentNullException](
        func () object? {
            return AsyncLetCell.Start(nil)
        }
    )

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
