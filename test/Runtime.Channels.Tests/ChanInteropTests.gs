// <copyright file="ChanInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Linq
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// ADR-0174 D1/D2: a (cref:Chan{T}) <em>is</em> a (cref:Channel{T})
/// — assignable, consumable by `ReadAllAsync`, honoring the BCL
/// reader/writer contracts — while refusing to fault.
open class ChanInteropTests {
    @Fact
    func Chan_IsAssignableTo_ChannelReaderAndWriter() {
        let ch = Chan[int32](1)
        let asChannel Channel[int32] = ch
        let reader = ch.Reader
        let writer = ch.Writer
        Assert.Same(ch, asChannel)
        Assert.True(writer.TryWrite(1))
        Assert.True(reader.TryRead(out var v))
        Assert.Equal(1, v)
        Assert.True(reader.CanCount)
        Assert.Equal(0, reader.Count)
        Assert.False(reader.CanPeek)
    }

    @Fact
    async func ReadAllAsync_ConsumesUntilClosed() {
        let ch = Chan[int32](2)
        let producer = Task.Run(
            async () -> {
                for var i = 0; i < 10; i++ {
                    await ch.Writer.WriteAsync(i)
                }
                ch.Writer.Complete()
            }
        )
        let seen = List[int32]()
        await for item in ch.Reader.ReadAllAsync() {
            seen.Add(item)
        }
        await producer.WaitAsync(ChanInteropTests.Timeout)
        Assert.Equal(10, seen.Count)
        Assert.Equal(45, seen.Sum())
        Assert.True(ch.Reader.Completion.IsCompletedSuccessfully)
    }

    @Fact
    async func ReadAsync_OnClosedAndDrained_ThrowsChannelClosed_PerBclContract() {
        let ch = Chan[int32](1)
        ch.TrySend(1)
        ch.Close()
        Assert.Equal(1, await ch.Reader.ReadAsync())
        await Assert.ThrowsAsync[ChannelClosedException](async () -> await ch.Reader.ReadAsync())
    }

    @Fact
    func TryWrite_OnClosed_ReturnsFalse_NotThrow() {
        let ch = Chan[int32](1)
        ch.Close()
        Assert.False(ch.Writer.TryWrite(1))
    }

    @Fact
    func TryComplete_WithError_IsRejected_ChanNeverFaults() {
        let ch = Chan[int32](1)
        Assert.Throws[NotSupportedException](
            func () object? {
                return ch.Writer.TryComplete(InvalidOperationException("boom"))
            }
        )
        Assert.False(ch.IsClosed)
        Assert.True(ch.Writer.TryComplete())
        Assert.False(ch.Writer.TryComplete())
        Assert.True(ch.IsClosed)
    }

    @Fact
    async func WaitToReadAsync_SignalsReadiness_AndFalseOnClose() {
        let ch = Chan[int32](1)
        let wait = ch.Reader.WaitToReadAsync().AsTask()
        Assert.False(wait.IsCompleted)
        ch.TrySend(1)
        Assert.True(await wait.WaitAsync(ChanInteropTests.Timeout))
        // Readiness, not reservation: the item is still there for TryRead.
        Assert.True(ch.Reader.TryRead(out var v))
        Assert.Equal(1, v)
        let waitAgain = ch.Reader.WaitToReadAsync().AsTask()
        ch.Close()
        Assert.False(await waitAgain.WaitAsync(ChanInteropTests.Timeout))
        Assert.False(await ch.Reader.WaitToReadAsync())
    }

    @Fact
    async func WaitToReadAsync_OnRendezvous_IsTrueWhenASenderIsParked() {
        let ch = Chan[int32]()
        let wait = ch.Reader.WaitToReadAsync().AsTask()
        Assert.False(wait.IsCompleted)
        let send = ch.SendAsync(3).AsTask()
        Assert.True(await wait.WaitAsync(ChanInteropTests.Timeout))
        Assert.True(ch.Reader.TryRead(out var v))
        Assert.Equal(3, v)
        await send.WaitAsync(ChanInteropTests.Timeout)
    }

    @Fact
    async func WaitToWriteAsync_SignalsRoom_AndFalseOnClose() {
        let ch = Chan[int32](1)
        Assert.True(await ch.Writer.WaitToWriteAsync())
        ch.TrySend(1)
        let wait = ch.Writer.WaitToWriteAsync().AsTask()
        Assert.False(wait.IsCompleted)
        ch.TryReceive(out _, out _)
        Assert.True(await wait.WaitAsync(ChanInteropTests.Timeout))
        ch.Close()
        Assert.False(await ch.Writer.WaitToWriteAsync())
    }

    @Fact
    async func WaitToReadAsync_Cancelled_Throws() {
        let ch = Chan[int32](1)
        using let cts = CancellationTokenSource()
        let wait = ch.Reader.WaitToReadAsync(cts.Token).AsTask()
        cts.Cancel()
        await Assert.ThrowsAsync[OperationCanceledException](
            func () Task {
                return wait.WaitAsync(ChanInteropTests.Timeout)
            }
        )
        Assert.Equal(0, ch.RegisteredWaiterCount)
    }

    @Fact
    func ReceiveResult_Deconstructs_ToGoShapedPair() {
        let (value, ok) = ReceiveResult[string]("x", true)
        Assert.Equal("x", value)
        Assert.True(ok)
        let (zero, closed) = ReceiveResult[int32].Closed
        Assert.Equal(0, zero)
        Assert.False(closed)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
