// <copyright file="Issue4681NilElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// Issue #4681: a channel of a nullable reference type must carry <c>nil</c>
/// through every runtime path. The runtime wrote <c>value!</c> on unconstrained
/// <c>T</c> values; that is a compile-time no-op in C#, but cs2gs carries each
/// one into the migrated runtime as a fail-fast <c>!!</c> that throws on
/// <c>nil</c>.
/// </summary>
/// <remarks>
/// A C# test cannot observe a <c>!</c>, so the discriminating witness for the
/// translation is <c>Issue4681ChannelsNullPassThroughTests</c> in Cs2Gs.Tests.
/// These tests pin the C# behavior the migrated runtime must keep, and fail if
/// anyone reintroduces a throwing assertion (a null check or
/// <c>ArgumentNullException.ThrowIfNull</c>) on an element.
/// </remarks>
public class Issue4681NilElementTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task BufferedNil_RoundTripsThroughEveryReceiveShape()
    {
        var ch = new Chan<string?>(8);

        Assert.True(ch.TrySend(null));
        Assert.Null(await ch.ReceiveValueAsync());

        Assert.True(ch.TrySend(null));
        var tuple = await ch.ReceiveTupleAsync();
        Assert.Null(tuple.Value);
        Assert.True(tuple.Ok);

        Assert.True(ch.TrySend(null));
        var result = await ch.ReceiveAsync();
        Assert.Null(result.Value);
        Assert.True(result.Ok);

        Assert.True(ch.TrySend(null));
        Assert.True(ch.TryReceive(out var value, out var ok));
        Assert.Null(value);
        Assert.True(ok);

        Assert.True(ch.TrySend(null));
        Assert.Equal((null, true), ChannelOps.Receive2(ch, CancellationToken.None));
    }

    [Fact]
    public async Task ParkedReceive_OfNil_DeliversNilToEveryShape()
    {
        var values = new Chan<string?>(0);
        var parked = values.ReceiveValueAsync().AsTask();
        Assert.False(parked.IsCompleted);
        await values.SendAsync(null).AsTask().WaitAsync(Timeout);
        Assert.Null(await parked.WaitAsync(Timeout));

        var tuples = new Chan<string?>(0);
        var parkedTuple = tuples.ReceiveTupleAsync().AsTask();
        Assert.False(parkedTuple.IsCompleted);
        await tuples.SendAsync(null).AsTask().WaitAsync(Timeout);
        var tuple = await parkedTuple.WaitAsync(Timeout);
        Assert.Null(tuple.Value);
        Assert.True(tuple.Ok);
    }

    [Fact]
    public async Task ParkedSend_OfNil_IsTakenByAReceiver()
    {
        var ch = new Chan<string?>(0);
        var send = ch.SendAsync(null).AsTask();
        Assert.False(send.IsCompleted);

        var tuple = await ch.ReceiveTupleAsync();
        await send.WaitAsync(Timeout);

        Assert.Null(tuple.Value);
        Assert.True(tuple.Ok);
    }

    [Fact]
    public async Task ClosedChannel_YieldsTheZeroValue_InEveryShape()
    {
        var ch = new Chan<string?>(1);
        ch.Close();

        Assert.Null(await ch.ReceiveValueAsync());
        var tuple = await ch.ReceiveTupleAsync();
        Assert.Null(tuple.Value);
        Assert.False(tuple.Ok);
    }

    [Fact]
    public async Task ReaderAdapter_CarriesNil()
    {
        var ch = new Chan<string?>(2);
        var reader = ch.Reader;

        Assert.True(ch.TrySend(null));
        Assert.True(reader.TryRead(out var item));
        Assert.Null(item);

        Assert.True(ch.TrySend(null));
        Assert.Null(await reader.ReadAsync().AsTask().WaitAsync(Timeout));
    }

    [Fact]
    public async Task SelectSend_OfNil_ProbesAndParks()
    {
        // Probe path: a buffered slot is free, so the send arm wins immediately.
        var buffered = new Chan<string?>(1);
        var probe = SelectWaiter.Rent(1, CancellationToken.None);
        probe.AddSend(buffered, (string?)null, 0);
        Assert.Equal(0, probe.TryNow());
        probe.Return();
        Assert.True(buffered.TryReceive(out var probed, out var probedOk));
        Assert.Null(probed);
        Assert.True(probedOk);

        // Registered path: a rendezvous channel has no receiver yet, so the arm
        // parks a SelectNode that still holds the nil.
        var rendezvous = new Chan<string?>(0);
        var parked = SelectWaiter.Rent(1, CancellationToken.None);
        parked.AddSend(rendezvous, (string?)null, 0);
        var wait = parked.WaitAsync().AsTask();
        Assert.False(wait.IsCompleted);

        var tuple = await rendezvous.ReceiveTupleAsync();
        Assert.Equal(0, await wait.WaitAsync(Timeout));
        parked.Return();
        Assert.Null(tuple.Value);
        Assert.True(tuple.Ok);
    }

    [Fact]
    public async Task SelectReceive_OfNil_ProbesAndParks()
    {
        var buffered = new Chan<string?>(1);
        Assert.True(buffered.TrySend(null));
        var probe = SelectWaiter.Rent(1, CancellationToken.None);
        probe.AddReceive(buffered, 0);
        Assert.Equal(0, probe.TryNow());
        Assert.True(probe.Ok);
        Assert.Null(probe.TakeValue<string?>());
        probe.Return();

        var rendezvous = new Chan<string?>(0);
        var parked = SelectWaiter.Rent(1, CancellationToken.None);
        parked.AddReceive(rendezvous, 0);
        var wait = parked.WaitAsync().AsTask();
        Assert.False(wait.IsCompleted);

        await rendezvous.SendAsync(null).AsTask().WaitAsync(Timeout);
        Assert.Equal(0, await wait.WaitAsync(Timeout));
        Assert.True(parked.Ok);
        Assert.Null(parked.TakeValue<string?>());
        parked.Return();
    }
}
