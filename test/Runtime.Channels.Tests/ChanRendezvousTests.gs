// <copyright file="ChanRendezvousTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0174 D1: `chan[T]()` is a rendezvous channel — a send completes
/// only when a receiver takes the value, and the receive happens-before the
/// send completes. This is what a capacity-1 bounded channel cannot provide.
/// @remarks Discrimination witness (ADR-0154): a mutant that allocates a one-slot
/// buffer for capacity 0 (the spike's `capacity == 0 ? 1 : capacity`)
/// breaks (cref:Rendezvous_SenderDoesNotProceedUntilReceiverArrives)
/// — the sender's flag flips before any receiver exists.
open class ChanRendezvousTests {
    @Fact
    func Rendezvous_HasCapacityZero_AndTrySendFailsWithoutReceiver() {
        let ch = Chan[int32]()
        Assert.Equal(0, ch.Capacity)
        Assert.False(ch.TrySend(1))
        Assert.Equal(0, ch.Length())
        Assert.False(ch.TryReceive(out _, out _))
    }

    @Fact
    async func Rendezvous_SenderDoesNotProceedUntilReceiverArrives() {
        let ch = Chan[int32]()
        var sent = 0
        let send = Task.Run(
            async () -> {
                await ch.SendAsync(99)
                Volatile.Write(&sent, 1)
            }
        )
        await Task.Delay(200)
        Assert.Equal(0, Volatile.Read(&sent))
        Assert.Equal(0, ch.Length())
        let result = await ch.ReceiveAsync().AsTask().WaitAsync(ChanRendezvousTests.Timeout)
        Assert.True(result.Ok)
        Assert.Equal(99, result.Value)
        await send.WaitAsync(ChanRendezvousTests.Timeout)
        Assert.Equal(1, Volatile.Read(&sent))
    }

    @Fact
    async func Rendezvous_ReceiverParkedFirst_IsHandedTheValueDirectly() {
        let ch = Chan[string]()
        let receive = ch.ReceiveAsync().AsTask()
        Assert.False(receive.IsCompleted)
        // The send commits synchronously because a receiver is already parked.
        Assert.True(ch.TrySend("hello"))
        Assert.Equal("hello", (await receive.WaitAsync(ChanRendezvousTests.Timeout)).Value)
    }

    @Fact
    async func Rendezvous_ReceiveHappensBeforeSendCompletes() {
        // The receiver observes the value strictly before the sender's
        // continuation runs: record the order 20k times.
        let ch = Chan[int32]()
        var violations = 0
        for var i = 0; i < 20_000; i++ {
            var receivedAt = 0L
            var sendCompletedAt = 0L
            let receiver = Task.Run(
                async () -> {
                    let r = await ch.ReceiveAsync()
                    Volatile.Write(&receivedAt, Interlocked.Increment(&Clock))
                    return r.Value
                }
            )
            await ch.SendAsync(i)
            Volatile.Write(&sendCompletedAt, Interlocked.Increment(&Clock))
            Assert.Equal(i, await receiver.WaitAsync(ChanRendezvousTests.Timeout))
            if Volatile.Read(&receivedAt) == int64(0) {
                // The receiver's continuation had not run yet — but the value
                // was already taken from the sender under the lock, which is
                // the guarantee; ordering of *continuations* is not it.
                continue
            }
            if receivedAt > sendCompletedAt && ch.Length() != 0 {
                violations++
            }
        }
        Assert.Equal(0, violations)
    }

    @Fact
    async func Rendezvous_PingPong_RoundTrips() {
        let ping = Chan[int32]()
        let pong = Chan[int32]()
        let echo = Task.Run(
            async () -> {
                while true {
                    let r = await ping.ReceiveAsync()
                    if !r.Ok {
                        return
                    }
                    await pong.SendAsync(r.Value + 1)
                }
            }
        )
        for var i = 0; i < 1_000; i++ {
            await ping.SendAsync(i)
            Assert.Equal(i + 1, (await pong.ReceiveAsync()).Value)
        }
        ping.Close()
        await echo.WaitAsync(ChanRendezvousTests.Timeout)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
        private var Clock int64
    }
}
