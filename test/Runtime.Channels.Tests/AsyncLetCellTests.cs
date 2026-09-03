// <copyright file="AsyncLetCellTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D15: the cell behind an <c>async let</c>. It is a child of the
/// enclosing scope frame, deposits its value exactly once, retires the frame's
/// registration exactly once whichever path gets there first, and — when
/// nobody reads the binding — cancels its child at scope exit and hands any
/// failure back to the scope rather than dropping it.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154, mutants applied to
/// <c>src/Sdk/Gsharp.Runtime.Channels/AsyncLetCell.cs</c>): making
/// <c>Register</c> a no-op breaks
/// <see cref="Register_AndComplete_LeaveTheFrameBalanced"/> — the frame's
/// pending count underflows and its exit throws; retiring the frame on every
/// completion path instead of once breaks the same test for the same reason;
/// dropping the <c>RecordChildFailure</c> hand-back breaks
/// <see cref="UnreadFailure_IsHandedBackToTheScope"/>, where the scope then
/// exits cleanly and the failure is lost; and cancelling the frame's context
/// rather than the cell's own breaks
/// <see cref="CancelIfUnread_CancelsOnlyItsOwnChild"/>.
/// </remarks>
public class AsyncLetCellTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task Register_AndComplete_LeaveTheFrameBalanced()
    {
        var frame = ScopeFrame.Enter(null);
        var cell = AsyncLetCell.Start(frame);
        cell.Register();
        Assert.Equal(2, frame.Pending);

        await cell.Run(7);

        // The work item calls Complete() after the body's ValueTask is
        // consumed; the deposit already retired the registration.
        cell.Complete();
        Assert.Equal(1, frame.Pending);
        Assert.Equal(7, await cell.AwaitAsync<int>().AsTask().WaitAsync(Timeout));

        await frame.ExitAsync();
    }

    [Fact]
    public async Task ReadTwice_ReturnsTheSameValue()
    {
        var frame = ScopeFrame.Enter(null);
        var cell = AsyncLetCell.Start(frame);
        cell.Register();
        await cell.Run(new ValueTask<string>("hello"));

        Assert.Equal("hello", await cell.AwaitAsync<string>());
        Assert.Equal("hello", await cell.AwaitAsync<string>());
        Assert.True(cell.WasRead);

        await frame.ExitAsync();
    }

    [Fact]
    public async Task AFailure_SurfacesAtTheRead_AndNotAtTheScope()
    {
        var frame = ScopeFrame.Enter(null);
        var cell = AsyncLetCell.Start(frame);
        cell.Register();
        cell.Fail(new InvalidOperationException("child failed"));

        var read = await Assert.ThrowsAsync<InvalidOperationException>(async () => await cell.AwaitAsync<int>());
        Assert.Equal("child failed", read.Message);

        // The reader saw it, so the scope exits cleanly.
        await cell.CancelIfUnreadAsync();
        await frame.ExitAsync();
    }

    [Fact]
    public async Task UnreadFailure_IsHandedBackToTheScope()
    {
        var frame = ScopeFrame.Enter(null);
        var cell = AsyncLetCell.Start(frame);
        cell.Register();
        cell.Fail(new InvalidOperationException("child failed"));

        await cell.CancelIfUnreadAsync();
        var scoped = await Assert.ThrowsAsync<ScopeException>(async () => await frame.ExitAsync());
        Assert.Contains(scoped.InnerExceptions, e => e.Message == "child failed");
    }

    [Fact]
    public async Task AFailingChild_DoesNotCancelTheScope()
    {
        // Swift's rule: catching one `async let` must not kill the ones running
        // beside it, so the cell does not cancel the frame's context.
        var frame = ScopeFrame.Enter(null);
        var cell = AsyncLetCell.Start(frame);
        cell.Register();
        cell.Fail(new InvalidOperationException("child failed"));

        Assert.False(frame.Context.IsCancelled);
        await Assert.ThrowsAsync<InvalidOperationException>(async () => await cell.AwaitAsync<int>());
        await frame.ExitAsync();
    }

    [Fact]
    public async Task CancelIfUnread_CancelsOnlyItsOwnChild()
    {
        var frame = ScopeFrame.Enter(null);
        var unread = AsyncLetCell.Start(frame);
        var other = AsyncLetCell.Start(frame);
        unread.Register();
        other.Register();

        var parked = new TaskCompletionSource();
        using var registration = unread.Context.Token.Register(() => parked.TrySetResult());

        var join = unread.CancelIfUnreadAsync().AsTask();
        await parked.Task.WaitAsync(Timeout);
        Assert.True(unread.Context.IsCancelled);
        Assert.False(other.Context.IsCancelled);
        Assert.False(frame.Context.IsCancelled);

        // The child observes the cancellation and reports it.
        unread.Fail(new OperationCanceledException(unread.Context.Token));
        await join.WaitAsync(Timeout);

        other.Complete();
        await frame.ExitAsync();
    }

    [Fact]
    public async Task CancelIfUnread_OnAReadBinding_DoesNothing()
    {
        var frame = ScopeFrame.Enter(null);
        var cell = AsyncLetCell.Start(frame);
        cell.Register();
        await cell.Run(3);
        Assert.Equal(3, await cell.AwaitAsync<int>());

        await cell.CancelIfUnreadAsync().AsTask().WaitAsync(Timeout);
        await frame.ExitAsync();
    }

    [Fact]
    public async Task TheChildsContext_IsLinkedToTheScopes()
    {
        var frame = ScopeFrame.Enter(null);
        var cell = AsyncLetCell.Start(frame);
        Assert.Same(frame.Context, cell.Context.Parent);

        frame.Context.TryCancel();
        Assert.True(cell.Context.IsCancelled);

        cell.Register();
        cell.Complete();
        await frame.ExitAsync();
    }

    [Fact]
    public void Start_WithoutAFrame_Throws()
        => Assert.Throws<ArgumentNullException>(() => AsyncLetCell.Start(null!));
}
