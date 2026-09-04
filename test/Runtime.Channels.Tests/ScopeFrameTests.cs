// <copyright file="ScopeFrameTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D6: the scope frame's join and its exit precedence table, one fact
/// per row, plus the two ordering rules — registration before queueing and
/// prompt sibling cancellation inside the failure path.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154, mutants applied to
/// <c>src/Sdk/Gsharp.Runtime.Channels/ScopeFrame.cs</c>): moving
/// <c>Context.TryCancel()</c> out of <c>RecordFailure</c> and into exit breaks
/// <see cref="Exit_ChildFailure_CancelsSiblingsBeforeExitCompletes"/> (the
/// sibling parks forever and the test times out); wrapping a lone body
/// exception in a <see cref="ScopeException"/> breaks
/// <see cref="Exit_BodyThrows_ChildrenSucceed_RethrowsBodyUnwrapped"/>;
/// listing sibling cancellations breaks
/// <see cref="Exit_SelfInflictedCancellation_DiscardsSiblingCancellations"/>.
/// </remarks>
public class ScopeFrameTests
{
    [Fact]
    public async Task Exit_NoFailures_CompletesQuietly()
    {
        var frame = ScopeFrame.Enter(Context.None);
        Spawn(frame, async () => await Task.Yield());
        Spawn(frame, () => ValueTask.CompletedTask);

        await frame.ExitAsync();

        Assert.Equal(0, frame.Pending);
    }

    [Fact]
    public async Task Exit_BodyThrows_ChildrenSucceed_RethrowsBodyUnwrapped()
    {
        var frame = ScopeFrame.Enter(Context.None);
        Spawn(frame, () => ValueTask.CompletedTask);
        var body = new InvalidOperationException("body");

        var thrown = await Assert.ThrowsAsync<InvalidOperationException>(async () => await frame.ExitAsync(body));

        Assert.Same(body, thrown);
    }

    [Fact]
    public async Task Exit_ChildrenFail_BodySucceeds_ThrowsScopeException_InCompletionOrder()
    {
        var frame = ScopeFrame.Enter(Context.None);
        var first = new InvalidOperationException("first");
        var second = new ArgumentException("second");
        frame.Register();
        frame.Register();
        frame.Fail(first);
        frame.Fail(second);

        var thrown = await Assert.ThrowsAsync<ScopeException>(async () => await frame.ExitAsync());

        Assert.Same(first, thrown.FirstFailure);
        Assert.Same(first, thrown.InnerException);
        Assert.Equal(new Exception[] { first, second }, thrown.InnerExceptions);
    }

    [Fact]
    public async Task Exit_BothFail_BodyAtIndexZero()
    {
        var frame = ScopeFrame.Enter(Context.None);
        var child = new InvalidOperationException("child");
        frame.Register();
        frame.Fail(child);
        var body = new ArgumentException("body");

        var thrown = await Assert.ThrowsAsync<ScopeException>(async () => await frame.ExitAsync(body));

        Assert.Same(body, thrown.FirstFailure);
        Assert.Equal(new Exception[] { body, child }, thrown.InnerExceptions);
    }

    [Fact]
    public async Task Exit_OuterCancellationOnly_ThrowsOperationCanceled()
    {
        using var outer = Context.None.WithCancel();
        var frame = ScopeFrame.Enter(outer);
        var parked = new TaskCompletionSource();
        Spawn(frame, async () =>
        {
            await parked.Task;
            frame.Context.ThrowIfCancelled();
        });

        outer.TryCancel();
        parked.SetResult();

        await Assert.ThrowsAsync<OperationCanceledException>(async () => await frame.ExitAsync());
    }

    [Fact]
    public async Task Exit_ChildFailure_CancelsSiblingsBeforeExitCompletes()
    {
        var frame = ScopeFrame.Enter(Context.None);
        var siblingUnparked = new TaskCompletionSource();
        Spawn(frame, async () =>
        {
            // Parks until the frame's context is cancelled — which only the
            // sibling's failure can do. If cancellation waited for the join,
            // this goroutine would never complete and the join would hang.
            var tcs = new TaskCompletionSource();
            using var registration = frame.Context.Token.Register(() => tcs.TrySetResult());
            await tcs.Task;
            siblingUnparked.TrySetResult();
            frame.Context.ThrowIfCancelled();
        });
        Spawn(frame, () => throw new InvalidOperationException("cause"));

        var thrown = await Assert.ThrowsAsync<ScopeException>(async () => await frame.ExitAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10)));

        Assert.True(siblingUnparked.Task.IsCompleted);
        Assert.IsType<InvalidOperationException>(thrown.FirstFailure);
    }

    [Fact]
    public async Task Exit_SelfInflictedCancellation_DiscardsSiblingCancellations()
    {
        var frame = ScopeFrame.Enter(Context.None);
        var cause = new InvalidOperationException("cause");
        frame.Register();
        frame.Register();
        frame.Register();
        frame.Fail(cause);
        frame.Fail(new OperationCanceledException(frame.Context.Token));
        frame.Fail(new OperationCanceledException(frame.Context.Token));

        var thrown = await Assert.ThrowsAsync<ScopeException>(async () => await frame.ExitAsync());

        Assert.Same(cause, Assert.Single(thrown.InnerExceptions));
    }

    [Fact]
    public async Task Exit_BodyCancelledByChildFailure_ReportsTheCause()
    {
        var frame = ScopeFrame.Enter(Context.None);
        var cause = new InvalidOperationException("cause");
        frame.Register();
        frame.Fail(cause);

        var thrown = await Assert.ThrowsAsync<ScopeException>(async () => await frame.ExitAsync(new OperationCanceledException(frame.Context.Token)));

        Assert.Same(cause, Assert.Single(thrown.InnerExceptions));
    }

    [Fact]
    public void Register_BeforeQueue_FastChildCannotUnderflow()
    {
        var frame = ScopeFrame.Enter(Context.None);
        for (var i = 0; i < 2000; i++)
        {
            Spawn(frame, () => ValueTask.CompletedTask);
        }

        frame.Exit();

        Assert.Equal(0, frame.Pending);
    }

    [Fact]
    public void Complete_MoreThanRegistered_Throws()
    {
        var frame = ScopeFrame.Enter(Context.None);
        frame.Complete();
        Assert.Throws<InvalidOperationException>(() => frame.Complete());
    }

    [Fact]
    public async Task Exit_DisposesTheContext()
    {
        var frame = ScopeFrame.Enter(Context.None);
        await frame.ExitAsync();
        Assert.False(frame.Context.TryCancel());
    }

    private static void Spawn(ScopeFrame frame, Func<ValueTask> body) => new DelegateWorkItem(frame, body).Start();

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
}
