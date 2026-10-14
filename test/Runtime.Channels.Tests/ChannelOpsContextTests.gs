// <copyright file="ChannelOpsContextTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading.Tasks
import Xunit

/// ADR-0174 D7: the (cref:Context)-taking facade forms are cancellation
/// points — a parked operation under a cancelled context unwinds with
/// (cref:OperationCanceledException), while (cref:Context.None)
/// never interrupts one.
open class ChannelOpsContextTests {
    @Fact
    async func ReceiveAsync_ParkedUnderCancelledContext_Throws() {
        using let context = Context.None.WithCancel()
        let channel = Chan[int32](1)
        let receive = ChannelOps.ReceiveAsync(channel, context).AsTask()
        Assert.False(receive.IsCompleted)
        context.TryCancel()
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return receive.WaitAsync(TimeSpan.FromSeconds(5))
            }
        )
    }

    @Fact
    async func SendAsync_ParkedUnderCancelledContext_Throws() {
        using let context = Context.None.WithCancel()
        let channel = Chan[int32](0)
        let send = ChannelOps.SendAsync(channel, 1, context).AsTask()
        Assert.False(send.IsCompleted)
        context.TryCancel()
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return send.WaitAsync(TimeSpan.FromSeconds(5))
            }
        )
    }

    @Fact
    func Receive2_UnderNone_DeliversAndReportsClose() {
        let channel = Chan[int32](1)
        ChannelOps.Send(channel, 7, Context.None)
        let (value, ok) = ChannelOps.Receive2(channel, Context.None)
        channel.Close()
        let (after, okAfter) = ChannelOps.Receive2(channel, Context.None)
        Assert.Equal((7, true), (value, ok))
        Assert.Equal((0, false), (after, okAfter))
    }

    @Fact
    func Receive_ThroughReaderAndWriterHandles_UnderContext() {
        let channel = Chan[string](2)
        ChannelOps.Send(channel.Writer, "a", Context.None)
        Assert.Equal("a", ChannelOps.Receive(channel.Reader, Context.None))
    }
}
