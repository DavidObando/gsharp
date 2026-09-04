// <copyright file="BlockingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>ADR-0174 D4: the root bridge returns a completed result without allocating and blocks on an incomplete one.</summary>
public class BlockingTests
{
    [Fact]
    public void Wait_CompletedValueTask_ReturnsResult()
    {
        Assert.Equal(7, Blocking.Wait(new ValueTask<int>(7)));
        Blocking.Wait(ValueTask.CompletedTask);
    }

    [Fact]
    public void Wait_IncompleteValueTask_BlocksUntilCompletion()
    {
        var tcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = Task.Run(async () =>
        {
            await Task.Delay(20);
            tcs.SetResult(42);
        });

        Assert.Equal(42, Blocking.Wait(new ValueTask<int>(tcs.Task)));
    }

    [Fact]
    public void Wait_FaultedValueTask_RethrowsTheFault()
    {
        var faulted = new ValueTask<int>(Task.FromException<int>(new InvalidOperationException("boom")));
        Assert.Throws<InvalidOperationException>(() => Blocking.Wait(faulted));
    }
}
