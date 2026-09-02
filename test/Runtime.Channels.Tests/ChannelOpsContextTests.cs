// <copyright file="ChannelOpsContextTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D7: the <see cref="Context"/>-taking facade forms are cancellation
/// points — a parked operation under a cancelled context unwinds with
/// <see cref="OperationCanceledException"/>, while <see cref="Context.None"/>
/// never interrupts one.
/// </summary>
public class ChannelOpsContextTests
{
    [Fact]
    public async Task ReceiveAsync_ParkedUnderCancelledContext_Throws()
    {
        using var context = Context.None.WithCancel();
        var channel = new Chan<int>(1);
        var receive = ChannelOps.ReceiveAsync(channel, context).AsTask();
        Assert.False(receive.IsCompleted);

        context.TryCancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => receive.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task SendAsync_ParkedUnderCancelledContext_Throws()
    {
        using var context = Context.None.WithCancel();
        var channel = new Chan<int>(0);
        var send = ChannelOps.SendAsync(channel, 1, context).AsTask();
        Assert.False(send.IsCompleted);

        context.TryCancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => send.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void Receive2_UnderNone_DeliversAndReportsClose()
    {
        var channel = new Chan<int>(1);
        ChannelOps.Send(channel, 7, Context.None);
        var (value, ok) = ChannelOps.Receive2(channel, Context.None);
        channel.Close();
        var (after, okAfter) = ChannelOps.Receive2(channel, Context.None);

        Assert.Equal((7, true), (value, ok));
        Assert.Equal((0, false), (after, okAfter));
    }

    [Fact]
    public void Receive_ThroughReaderAndWriterHandles_UnderContext()
    {
        var channel = new Chan<string>(2);
        ChannelOps.Send(channel.Writer, "a", Context.None);
        Assert.Equal("a", ChannelOps.Receive(channel.Reader, Context.None));
    }
}
