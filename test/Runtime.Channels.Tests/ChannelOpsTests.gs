// <copyright file="ChannelOpsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Collections.Concurrent
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// ADR-0174 D2 operation matrix through the (cref:ChannelOps) facade:
/// fast path for a (cref:Chan{T}), the documented fallback for foreign
/// BCL channels, readers, and writers, and the `nil`-blocks-forever rule.
/// @remarks Discrimination witnesses (ADR-0154, mutants applied to
/// `src/Sdk/Gsharp.Runtime.Channels/ChannelOps.cs`): replacing the
/// foreign fallback <em>loop</em> with a single `WaitToReadAsync` +
/// `TryRead` breaks (cref:ForeignReader_FallbackLoop_UnderCompetingConsumer_NeverLosesOrDuplicates)
/// (a spurious `(default, true)` or a lost item appears within 20 000
/// items); routing a (cref:Chan{T}) close through `TryComplete()`
/// breaks (cref:Close_OnChan_TwiceThrows_ButForeignDoesNot).
open class ChannelOpsTests {
    @Fact
    func Receive_OnChan_FastPath_ReturnsValueAndZeroOnClosed() {
        let ch = Chan[int32](1)
        ChannelOps.Send[int32](ch, 5, CancellationToken.None)
        Assert.Equal(5, ChannelOps.Receive[int32](ch, CancellationToken.None))
        ch.Close()
        Assert.Equal(0, ChannelOps.Receive[int32](ch, CancellationToken.None))
        Assert.Equal((0, false), ChannelOps.Receive2[int32](ch, CancellationToken.None))
    }

    @Fact
    async func Receive_OnChan_BlocksUntilSend_ThenReturns() {
        let ch = Chan[int32]()
        let receive = Task.Run(() -> ChannelOps.Receive[int32](ch, CancellationToken.None))
        await Task.Delay(50)
        Assert.False(receive.IsCompleted)
        await ch.SendAsync(9)
        Assert.Equal(9, await receive.WaitAsync(ChannelOpsTests.Timeout))
    }

    @Fact
    func Send_OnClosedChan_Throws() {
        let ch = Chan[int32](1)
        ch.Close()
        Assert.Throws[ChannelClosedException](() -> ChannelOps.Send[int32](ch, 1, CancellationToken.None))
    }

    @Fact
    func Receive_ThroughReaderAndWriterHandles_UnwrapsToFastPath() {
        let ch = Chan[string](2)
        let writer = ch.Writer
        let reader = ch.Reader
        ChannelOps.Send(writer, "a", CancellationToken.None)
        ChannelOps.Send(writer, "b", CancellationToken.None)
        Assert.Equal("a", ChannelOps.Receive(reader, CancellationToken.None))
        Assert.Equal(("b", true), ChannelOps.Receive2(reader, CancellationToken.None))
        ChannelOps.Close(writer)
        Assert.Equal((default(string), false), ChannelOps.Receive2(reader, CancellationToken.None))
    }

    @Fact
    func Foreign_BclChannel_SendReceiveClose_ViaFallback() {
        let foreign = Channel.CreateBounded[int32](2)
        ChannelOps.Send[int32](foreign, 1, CancellationToken.None)
        ChannelOps.Send[int32](foreign, 2, CancellationToken.None)
        Assert.Equal(1, ChannelOps.Receive[int32](foreign, CancellationToken.None))
        ChannelOps.Close[int32](foreign)
        Assert.Equal((2, true), ChannelOps.Receive2[int32](foreign, CancellationToken.None))
        Assert.Equal((0, false), ChannelOps.Receive2[int32](foreign, CancellationToken.None))
        Assert.Equal(0, ChannelOps.Receive[int32](foreign, CancellationToken.None))
    }

    @Fact
    async func Foreign_BclChannel_Async_SendReceive_ViaFallback() {
        let foreign = Channel.CreateBounded[int32](1)
        let receive = ChannelOps.ReceiveAsync[int32](foreign, CancellationToken.None).AsTask()
        Assert.False(receive.IsCompleted)
        await ChannelOps.SendAsync[int32](foreign, 7, CancellationToken.None)
        Assert.Equal(7, (await receive.WaitAsync(ChannelOpsTests.Timeout)).Value)
        foreign.Writer.Complete()
        Assert.False((await ChannelOps.ReceiveAsync[int32](foreign, CancellationToken.None)).Ok)
    }

    @Fact
    async func ForeignReader_FallbackLoop_UnderCompetingConsumer_NeverLosesOrDuplicates() {
        const Items = 20_000
        let foreign = Channel.CreateBounded[int32](1)
        let seen = ConcurrentDictionary[int32, uint8]()
        var duplicates = 0
        let producer = Task.Run(
            async () -> {
                for var i = 0; i < Items; i++ {
                    await foreign.Writer.WriteAsync(i)
                }
                foreign.Writer.Complete()
            }
        )
        // A thief consumer using raw TryRead competes with the facade.
        let thief = Task.Run(
            async () -> {
                while await foreign.Reader.WaitToReadAsync() {
                    while foreign.Reader.TryRead(out var v) {
                        if !seen.TryAdd(v, uint8(0)) {
                            Interlocked.Increment(&duplicates)
                        }
                    }
                }
            }
        )
        let facade = Task.Run(
            () -> {
                while true {
                    let (value, ok) = ChannelOps.Receive2(foreign.Reader, CancellationToken.None)
                    if !ok {
                        return
                    }
                    if !seen.TryAdd(value, uint8(0)) {
                        Interlocked.Increment(&duplicates)
                    }
                }
            }
        )
        await Task.WhenAll(producer, thief, facade).WaitAsync(ChannelOpsTests.Timeout)
        Assert.Equal(0, duplicates)
        Assert.Equal(Items, seen.Count)
    }

    @Fact
    func Close_OnChan_TwiceThrows_ButForeignDoesNot() {
        let chan_ Channel[int32] = Chan[int32](1)
        ChannelOps.Close(chan_)
        Assert.Throws[ChannelClosedException](() -> ChannelOps.Close(chan_))
        let foreign = Channel.CreateUnbounded[int32]()
        ChannelOps.Close(foreign)
        ChannelOps.Close(foreign)
        Assert.True(foreign.Reader.Completion.IsCompleted)
    }

    @Fact
    func Close_Extension_BindsOnChannelAndWriter_NotOnReader() {
        let chan_ Channel[int32] = Chan[int32](1)
        chan_.Close()
        Assert.True((cast[Chan[int32]](chan_)).IsClosed)
        let other = Chan[int32](1)
        let writer = other.Writer
        writer.Close()
        Assert.True(other.IsClosed)
        // in chan[T] is ChannelReader<T>, which has no Close — ordinary
        // member-not-found in G#; here we can only pin that the extension
        // is not defined for readers.
        Assert.Null(
            typeof(ChannelExtensions).GetMethods().FirstOrDefault(
                (m MethodInfo) -> m.Name == "Close" && m.GetParameters()[0].ParameterType.Name == "ChannelReader`1"
            )
        )
    }

    @Fact
    func Close_OnNil_Throws() {
        Assert.Throws[ChannelClosedException](() -> ChannelOps.Close[int32](default(Channel[int32]?)))
        Assert.Throws[ChannelClosedException](() -> ChannelOps.Close[int32](default(ChannelWriter[int32]?)))
    }

    @Fact
    async func NilChannel_BlocksForever_UntilCancelled() {
        using let cts = CancellationTokenSource(100)
        let blocking = Task.Run(() -> ChannelOps.Receive[int32](default(Channel[int32]?), cts.Token))
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return blocking.WaitAsync(ChannelOpsTests.Timeout)
            }
        )
        using let cts2 = CancellationTokenSource(100)
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            async () -> await ChannelOps.ReceiveAsync[int32](default(Channel[int32]?), cts2.Token)
        )
        using let cts3 = CancellationTokenSource(100)
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            async () -> {
                await ChannelOps.SendAsync[int32](default(ChannelWriter[int32]?), 1, cts3.Token)
            }
        )
    }

    @Fact
    async func FaultedForeignCompletion_PropagatesAsThrow_NotAsClose() {
        let foreign = Channel.CreateUnbounded[int32]()
        foreign.Writer.TryComplete(InvalidOperationException("upstream failed"))
        Assert.Throws[InvalidOperationException](
            func () object? {
                return ChannelOps.Receive[int32](foreign, CancellationToken.None)
            }
        )
        await Assert.ThrowsAsync[InvalidOperationException](
            async () -> await ChannelOps.ReceiveAsync[int32](foreign, CancellationToken.None)
        )
    }

    @Fact
    func Receive_Cancelled_WhileBlocked_Throws() {
        let ch = Chan[int32]()
        using let cts = CancellationTokenSource(100)
        Assert.ThrowsAny[OperationCanceledException](
            func () object? {
                return ChannelOps.Receive[int32](ch, cts.Token)
            }
        )
        Assert.Equal(0, ch.RegisteredWaiterCount)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(20)
    }
}
