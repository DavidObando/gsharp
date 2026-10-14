// <copyright file="ContextTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0174 D6/D7: the (cref:Context) tree. (cref:Context.None)
/// never cancels, a child cancels with its parent and on its own
/// (cref:Context.TryCancel), a timeout child cancels on schedule, and a
/// shielded child ignores its parent's cancellation.
/// @remarks Discrimination witness (ADR-0154): a mutant that derives
/// (cref:Context.Shielded) from the parent's token (instead of
/// (cref:CancellationToken.None)) breaks
/// (cref:Shielded_IgnoresParentCancellation); a mutant that creates an
/// unlinked source in (cref:Context.WithCancel) breaks
/// (cref:WithCancel_CancelsWithItsParent).
open class ContextTests {
    @Fact
    func None_NeverCancels_AndCannotBeCancelled() {
        Assert.False(Context.None.IsCancelled)
        Assert.False(Context.None.Token.CanBeCanceled)
        Assert.False(Context.None.TryCancel())
        Assert.Null(Context.None.Parent)
        Assert.Same(Context.None, Context.FromToken(CancellationToken.None))
    }

    @Fact
    func WithCancel_CancelsWithItsParent() {
        using let parent = Context.None.WithCancel()
        using let child = parent.WithCancel()
        Assert.Same(parent, child.Parent)
        Assert.True(parent.TryCancel())
        Assert.True(parent.IsCancelled)
        Assert.True(child.IsCancelled)
    }

    @Fact
    func WithCancel_ChildCancellation_DoesNotReachTheParent() {
        using let parent = Context.None.WithCancel()
        using let child = parent.WithCancel()
        Assert.True(child.TryCancel())
        Assert.True(child.IsCancelled)
        Assert.False(parent.IsCancelled)
    }

    @Fact
    async func WithTimeout_CancelsOnSchedule() {
        using let timed = Context.None.WithTimeout(TimeSpan.FromMilliseconds(20))
        Assert.False(timed.IsCancelled)
        let tcs = TaskCompletionSource()
        using let registration = timed.Token.Register(() -> tcs.TrySetResult())
        await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5))
        Assert.True(timed.IsCancelled)
    }

    @Fact
    func Shielded_IgnoresParentCancellation() {
        using let parent = Context.None.WithCancel()
        let shielded = parent.Shielded()
        Assert.True(shielded.IsShielded)
        Assert.Same(parent, shielded.Parent)
        parent.TryCancel()
        Assert.False(shielded.IsCancelled)
        Assert.False(shielded.TryCancel())
    }

    @Fact
    func FromToken_ObservesTheForeignToken_AndCannotCancelIt() {
        using let cts = CancellationTokenSource()
        let wrapped = Context.FromToken(cts.Token)
        Assert.False(wrapped.TryCancel())
        Assert.False(wrapped.IsCancelled)
        cts.Cancel()
        Assert.True(wrapped.IsCancelled)
        Assert.Throws[OperationCanceledException](() -> wrapped.ThrowIfCancelled())
    }

    @Fact
    func Dispose_ThenTryCancel_ReportsFalse_InsteadOfThrowing() {
        let context = Context.None.WithCancel()
        context.Dispose()
        Assert.False(context.TryCancel())
    }
}
