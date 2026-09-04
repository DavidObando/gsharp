// <copyright file="ChannelOpsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D2 operation matrix through the <see cref="ChannelOps"/> facade:
/// fast path for a <see cref="Chan{T}"/>, the documented fallback for foreign
/// BCL channels, readers, and writers, and the <c>nil</c>-blocks-forever rule.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154, mutants applied to
/// <c>src/Sdk/Gsharp.Runtime.Channels/ChannelOps.cs</c>): replacing the
/// foreign fallback <em>loop</em> with a single <c>WaitToReadAsync</c> +
/// <c>TryRead</c> breaks <see cref="ForeignReader_FallbackLoop_UnderCompetingConsumer_NeverLosesOrDuplicates"/>
/// (a spurious <c>(default, true)</c> or a lost item appears within 20 000
/// items); routing a <see cref="Chan{T}"/> close through <c>TryComplete()</c>
/// breaks <see cref="Close_OnChan_TwiceThrows_ButForeignDoesNot"/>.
/// </remarks>
public class ChannelOpsTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    [Fact]
    public void Receive_OnChan_FastPath_ReturnsValueAndZeroOnClosed()
    {
        var ch = new Chan<int>(1);
        ChannelOps.Send<int>(ch, 5, CancellationToken.None);
        Assert.Equal(5, ChannelOps.Receive<int>(ch, CancellationToken.None));
        ch.Close();
        Assert.Equal(0, ChannelOps.Receive<int>(ch, CancellationToken.None));
        Assert.Equal((0, false), ChannelOps.Receive2<int>(ch, CancellationToken.None));
    }

    [Fact]
    public async Task Receive_OnChan_BlocksUntilSend_ThenReturns()
    {
        var ch = new Chan<int>();
        var receive = Task.Run(() => ChannelOps.Receive<int>(ch, CancellationToken.None));
        await Task.Delay(50);
        Assert.False(receive.IsCompleted);
        await ch.SendAsync(9);
        Assert.Equal(9, await receive.WaitAsync(Timeout));
    }

    [Fact]
    public void Send_OnClosedChan_Throws()
    {
        var ch = new Chan<int>(1);
        ch.Close();
        Assert.Throws<ChannelClosedException>(() => ChannelOps.Send<int>(ch, 1, CancellationToken.None));
    }

    [Fact]
    public void Receive_ThroughReaderAndWriterHandles_UnwrapsToFastPath()
    {
        var ch = new Chan<string>(2);
        ChannelWriter<string> writer = ch.Writer;
        ChannelReader<string> reader = ch.Reader;
        ChannelOps.Send(writer, "a", CancellationToken.None);
        ChannelOps.Send(writer, "b", CancellationToken.None);
        Assert.Equal("a", ChannelOps.Receive(reader, CancellationToken.None));
        Assert.Equal(("b", true), ChannelOps.Receive2(reader, CancellationToken.None));
        ChannelOps.Close(writer);
        Assert.Equal((null, false), ChannelOps.Receive2(reader, CancellationToken.None));
    }

    [Fact]
    public void Foreign_BclChannel_SendReceiveClose_ViaFallback()
    {
        var foreign = Channel.CreateBounded<int>(2);
        ChannelOps.Send<int>(foreign, 1, CancellationToken.None);
        ChannelOps.Send<int>(foreign, 2, CancellationToken.None);
        Assert.Equal(1, ChannelOps.Receive<int>(foreign, CancellationToken.None));
        ChannelOps.Close<int>(foreign);
        Assert.Equal((2, true), ChannelOps.Receive2<int>(foreign, CancellationToken.None));
        Assert.Equal((0, false), ChannelOps.Receive2<int>(foreign, CancellationToken.None));
        Assert.Equal(0, ChannelOps.Receive<int>(foreign, CancellationToken.None));
    }

    [Fact]
    public async Task Foreign_BclChannel_Async_SendReceive_ViaFallback()
    {
        var foreign = Channel.CreateBounded<int>(1);
        var receive = ChannelOps.ReceiveAsync<int>(foreign, CancellationToken.None).AsTask();
        Assert.False(receive.IsCompleted);
        await ChannelOps.SendAsync<int>(foreign, 7, CancellationToken.None);
        Assert.Equal(7, (await receive.WaitAsync(Timeout)).Value);
        foreign.Writer.Complete();
        Assert.False((await ChannelOps.ReceiveAsync<int>(foreign, CancellationToken.None)).Ok);
    }

    [Fact]
    public async Task ForeignReader_FallbackLoop_UnderCompetingConsumer_NeverLosesOrDuplicates()
    {
        const int Items = 20_000;
        var foreign = Channel.CreateBounded<int>(1);
        var seen = new ConcurrentDictionary<int, byte>();
        var duplicates = 0;

        var producer = Task.Run(async () =>
        {
            for (var i = 0; i < Items; i++)
            {
                await foreign.Writer.WriteAsync(i);
            }

            foreign.Writer.Complete();
        });

        // A thief consumer using raw TryRead competes with the facade.
        var thief = Task.Run(async () =>
        {
            while (await foreign.Reader.WaitToReadAsync())
            {
                while (foreign.Reader.TryRead(out var v))
                {
                    if (!seen.TryAdd(v, 0))
                    {
                        Interlocked.Increment(ref duplicates);
                    }
                }
            }
        });

        var facade = Task.Run(() =>
        {
            while (true)
            {
                var (value, ok) = ChannelOps.Receive2(foreign.Reader, CancellationToken.None);
                if (!ok)
                {
                    return;
                }

                if (!seen.TryAdd(value, 0))
                {
                    Interlocked.Increment(ref duplicates);
                }
            }
        });

        await Task.WhenAll(producer, thief, facade).WaitAsync(Timeout);
        Assert.Equal(0, duplicates);
        Assert.Equal(Items, seen.Count);
    }

    [Fact]
    public void Close_OnChan_TwiceThrows_ButForeignDoesNot()
    {
        Channel<int> chan = new Chan<int>(1);
        ChannelOps.Close(chan);
        Assert.Throws<ChannelClosedException>(() => ChannelOps.Close(chan));

        Channel<int> foreign = Channel.CreateUnbounded<int>();
        ChannelOps.Close(foreign);
        ChannelOps.Close(foreign);
        Assert.True(foreign.Reader.Completion.IsCompleted);
    }

    [Fact]
    public void Close_Extension_BindsOnChannelAndWriter_NotOnReader()
    {
        Channel<int> chan = new Chan<int>(1);
        chan.Close();
        Assert.True(((Chan<int>)chan).IsClosed);

        var other = new Chan<int>(1);
        ChannelWriter<int> writer = other.Writer;
        writer.Close();
        Assert.True(other.IsClosed);

        // in chan[T] is ChannelReader<T>, which has no Close — ordinary
        // member-not-found in G#; here we can only pin that the extension
        // is not defined for readers.
        Assert.Null(typeof(ChannelExtensions).GetMethods()
            .FirstOrDefault(m => m.Name == "Close" && m.GetParameters()[0].ParameterType.Name == "ChannelReader`1"));
    }

    [Fact]
    public void Close_OnNil_Throws()
    {
        Assert.Throws<ChannelClosedException>(() => ChannelOps.Close<int>((Channel<int>?)null));
        Assert.Throws<ChannelClosedException>(() => ChannelOps.Close<int>((ChannelWriter<int>?)null));
    }

    [Fact]
    public async Task NilChannel_BlocksForever_UntilCancelled()
    {
        using var cts = new CancellationTokenSource(100);
        var blocking = Task.Run(() => ChannelOps.Receive<int>((Channel<int>?)null, cts.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => blocking.WaitAsync(Timeout));

        using var cts2 = new CancellationTokenSource(100);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            async () => await ChannelOps.ReceiveAsync<int>((Channel<int>?)null, cts2.Token));

        using var cts3 = new CancellationTokenSource(100);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            async () => await ChannelOps.SendAsync<int>((ChannelWriter<int>?)null, 1, cts3.Token));
    }

    [Fact]
    public async Task FaultedForeignCompletion_PropagatesAsThrow_NotAsClose()
    {
        var foreign = Channel.CreateUnbounded<int>();
        foreign.Writer.TryComplete(new InvalidOperationException("upstream failed"));
        Assert.Throws<InvalidOperationException>(() => ChannelOps.Receive<int>(foreign, CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(async () => await ChannelOps.ReceiveAsync<int>(foreign, CancellationToken.None));
    }

    [Fact]
    public void Receive_Cancelled_WhileBlocked_Throws()
    {
        var ch = new Chan<int>();
        using var cts = new CancellationTokenSource(100);
        Assert.ThrowsAny<OperationCanceledException>(() => ChannelOps.Receive<int>(ch, cts.Token));
        Assert.Equal(0, ch.RegisteredWaiterCount);
    }
}
