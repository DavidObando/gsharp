// <copyright file="ContextTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D6/D7: the <see cref="Context"/> tree. <see cref="Context.None"/>
/// never cancels, a child cancels with its parent and on its own
/// <see cref="Context.TryCancel"/>, a timeout child cancels on schedule, and a
/// shielded child ignores its parent's cancellation.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that derives
/// <see cref="Context.Shielded"/> from the parent's token (instead of
/// <see cref="CancellationToken.None"/>) breaks
/// <see cref="Shielded_IgnoresParentCancellation"/>; a mutant that creates an
/// unlinked source in <see cref="Context.WithCancel"/> breaks
/// <see cref="WithCancel_CancelsWithItsParent"/>.
/// </remarks>
public class ContextTests
{
    [Fact]
    public void None_NeverCancels_AndCannotBeCancelled()
    {
        Assert.False(Context.None.IsCancelled);
        Assert.False(Context.None.Token.CanBeCanceled);
        Assert.False(Context.None.TryCancel());
        Assert.Null(Context.None.Parent);
        Assert.Same(Context.None, Context.FromToken(CancellationToken.None));
    }

    [Fact]
    public void WithCancel_CancelsWithItsParent()
    {
        using var parent = Context.None.WithCancel();
        using var child = parent.WithCancel();
        Assert.Same(parent, child.Parent);

        Assert.True(parent.TryCancel());

        Assert.True(parent.IsCancelled);
        Assert.True(child.IsCancelled);
    }

    [Fact]
    public void WithCancel_ChildCancellation_DoesNotReachTheParent()
    {
        using var parent = Context.None.WithCancel();
        using var child = parent.WithCancel();

        Assert.True(child.TryCancel());

        Assert.True(child.IsCancelled);
        Assert.False(parent.IsCancelled);
    }

    [Fact]
    public async Task WithTimeout_CancelsOnSchedule()
    {
        using var timed = Context.None.WithTimeout(TimeSpan.FromMilliseconds(20));
        Assert.False(timed.IsCancelled);

        var tcs = new TaskCompletionSource();
        using var registration = timed.Token.Register(() => tcs.TrySetResult());
        await tcs.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.True(timed.IsCancelled);
    }

    [Fact]
    public void Shielded_IgnoresParentCancellation()
    {
        using var parent = Context.None.WithCancel();
        var shielded = parent.Shielded();
        Assert.True(shielded.IsShielded);
        Assert.Same(parent, shielded.Parent);

        parent.TryCancel();

        Assert.False(shielded.IsCancelled);
        Assert.False(shielded.TryCancel());
    }

    [Fact]
    public void FromToken_ObservesTheForeignToken_AndCannotCancelIt()
    {
        using var cts = new CancellationTokenSource();
        var wrapped = Context.FromToken(cts.Token);
        Assert.False(wrapped.TryCancel());
        Assert.False(wrapped.IsCancelled);

        cts.Cancel();

        Assert.True(wrapped.IsCancelled);
        Assert.Throws<OperationCanceledException>(() => wrapped.ThrowIfCancelled());
    }

    [Fact]
    public void Dispose_ThenTryCancel_ReportsFalse_InsteadOfThrowing()
    {
        var context = Context.None.WithCancel();
        context.Dispose();
        Assert.False(context.TryCancel());
    }
}
