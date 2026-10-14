// <copyright file="Issue4681NilElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #4681: a channel of a nullable reference type must carry `nil`
/// through every runtime path. The runtime wrote `value!` on unconstrained
/// `T` values; that is a compile-time no-op in C#, but cs2gs carries each
/// one into the migrated runtime as a fail-fast `!!` that throws on
/// `nil`.
/// @remarks A C# test cannot observe a `!`, so the discriminating witness for the
/// translation is `Issue4681ChannelsNullPassThroughTests` in Cs2Gs.Tests.
/// These tests pin the C# behavior the migrated runtime must keep, and fail if
/// anyone reintroduces a throwing assertion (a null check or
/// `ArgumentNullException.ThrowIfNull`) on an element.
open class Issue4681NilElementTests {
    @Fact
    async func BufferedNil_RoundTripsThroughEveryReceiveShape() {
        let ch = Chan[string?](8)
        Assert.True(ch.TrySend(nil))
        Assert.Null(await ch.ReceiveValueAsync())
        Assert.True(ch.TrySend(nil))
        let tuple = await ch.ReceiveTupleAsync()
        Assert.Null(tuple.Item1)
        Assert.True(tuple.Item2)
        Assert.True(ch.TrySend(nil))
        let result = await ch.ReceiveAsync()
        Assert.Null(result.Value)
        Assert.True(result.Ok)
        Assert.True(ch.TrySend(nil))
        Assert.True(ch.TryReceive(out var value, out var ok))
        Assert.Null(value)
        Assert.True(ok)
        Assert.True(ch.TrySend(nil))
        let received = ChannelOps.Receive2(ch, CancellationToken.None)
        Assert.Null(received.Item1)
        Assert.True(received.Item2)
    }

    @Fact
    async func ParkedReceive_OfNil_DeliversNilToEveryShape() {
        let values = Chan[string?](0)
        let parked = values.ReceiveValueAsync().AsTask()
        Assert.False(parked.IsCompleted)
        await values.SendAsync(nil).AsTask().WaitAsync(Issue4681NilElementTests.Timeout)
        Assert.Null(await parked.WaitAsync(Issue4681NilElementTests.Timeout))
        let tuples = Chan[string?](0)
        let parkedTuple = tuples.ReceiveTupleAsync().AsTask()
        Assert.False(parkedTuple.IsCompleted)
        await tuples.SendAsync(nil).AsTask().WaitAsync(Issue4681NilElementTests.Timeout)
        let tuple = await parkedTuple.WaitAsync(Issue4681NilElementTests.Timeout)
        Assert.Null(tuple.Item1)
        Assert.True(tuple.Item2)
    }

    @Fact
    async func ParkedSend_OfNil_IsTakenByAReceiver() {
        let ch = Chan[string?](0)
        let send = ch.SendAsync(nil).AsTask()
        Assert.False(send.IsCompleted)
        let tuple = await ch.ReceiveTupleAsync()
        await send.WaitAsync(Issue4681NilElementTests.Timeout)
        Assert.Null(tuple.Item1)
        Assert.True(tuple.Item2)
    }

    @Fact
    async func ClosedChannel_YieldsTheZeroValue_InEveryShape() {
        let ch = Chan[string?](1)
        ch.Close()
        Assert.Null(await ch.ReceiveValueAsync())
        let tuple = await ch.ReceiveTupleAsync()
        Assert.Null(tuple.Item1)
        Assert.False(tuple.Item2)
    }

    @Fact
    async func ReaderAdapter_CarriesNil() {
        let ch = Chan[string?](2)
        let reader = ch.Reader
        Assert.True(ch.TrySend(nil))
        Assert.True(reader.TryRead(out var item))
        Assert.Null(item)
        Assert.True(ch.TrySend(nil))
        Assert.Null(await reader.ReadAsync().AsTask().WaitAsync(Issue4681NilElementTests.Timeout))
    }

    @Fact
    async func SelectSend_OfNil_ProbesAndParks() {
        // Probe path: a buffered slot is free, so the send arm wins immediately.
        let buffered = Chan[string?](1)
        let probe = SelectWaiter.Rent(1, CancellationToken.None)
        probe.AddSend(buffered, default(string?), 0)
        Assert.Equal(0, probe.TryNow())
        probe.Return()
        Assert.True(buffered.TryReceive(out var probed, out var probedOk))
        Assert.Null(probed)
        Assert.True(probedOk)
        // Registered path: a rendezvous channel has no receiver yet, so the arm
        // parks a SelectNode that still holds the nil.
        let rendezvous = Chan[string?](0)
        let parked = SelectWaiter.Rent(1, CancellationToken.None)
        parked.AddSend(rendezvous, default(string?), 0)
        let wait = parked.WaitAsync().AsTask()
        Assert.False(wait.IsCompleted)
        let tuple = await rendezvous.ReceiveTupleAsync()
        Assert.Equal(0, await wait.WaitAsync(Issue4681NilElementTests.Timeout))
        parked.Return()
        Assert.Null(tuple.Item1)
        Assert.True(tuple.Item2)
    }

    @Fact
    async func SelectReceive_OfNil_ProbesAndParks() {
        let buffered = Chan[string?](1)
        Assert.True(buffered.TrySend(nil))
        let probe = SelectWaiter.Rent(1, CancellationToken.None)
        probe.AddReceive(buffered, 0)
        Assert.Equal(0, probe.TryNow())
        Assert.True(probe.Ok)
        Assert.Null(probe.TakeValue[string?]())
        probe.Return()
        let rendezvous = Chan[string?](0)
        let parked = SelectWaiter.Rent(1, CancellationToken.None)
        parked.AddReceive(rendezvous, 0)
        let wait = parked.WaitAsync().AsTask()
        Assert.False(wait.IsCompleted)
        await rendezvous.SendAsync(nil).AsTask().WaitAsync(Issue4681NilElementTests.Timeout)
        Assert.Equal(0, await wait.WaitAsync(Issue4681NilElementTests.Timeout))
        Assert.True(parked.Ok)
        Assert.Null(parked.TakeValue[string?]())
        parked.Return()
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
