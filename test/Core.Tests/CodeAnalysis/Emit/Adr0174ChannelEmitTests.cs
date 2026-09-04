// <copyright file="Adr0174ChannelEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Threading.Channels;
using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D1/D2/D12 through real emitted execution: <c>chan[T](n)</c>
/// constructs the runtime's <c>Chan&lt;T&gt;</c>, the operators lower onto
/// <c>ChannelOps</c>, a closed receive yields the zero value with no exception,
/// directional handles are views of one channel, and foreign BCL channels flow
/// into <c>chan[T]</c> / <c>in chan[T]</c> with no adapter (the D2 matrix).
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): re-introducing a
/// <c>ChannelClosedException</c>-based closed-receive path (wave 1's lowering)
/// breaks <see cref="ClosedReceive_YieldsZero_WithoutAFirstChanceException"/>,
/// which counts first-chance <c>ChannelClosedException</c>s during 500 closed
/// receives and demands zero.
/// </remarks>
public class Adr0174ChannelEmitTests
{
    [Fact]
    public void BufferedChannel_IsFifo_AndReportsLengthAndCapacity()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Fifo

            let ch = chan[int32](3)
            ch <- 10
            ch <- 20
            let length = ch.Length()
            let capacity = ch.Capacity
            let first = <-ch
            let second = <-ch
            length * 1000 + capacity * 100 + first + second
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(2330, result.Value);
    }

    [Fact]
    public void RendezvousConstruction_HasCapacityZero()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Rendezvous

            let ch = chan[int32]()
            ch.Capacity
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0548");
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Unbounded_AcceptsManySends_WithoutAReceiver()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Unbounded

            let ch = Chan.Unbounded[int32]()
            for i in 0 ... 10000 {
                ch <- i
            }
            ch.Length()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(10000, result.Value);
    }

    [Fact]
    public void ClosedReceive_YieldsZero_WithoutAFirstChanceException()
    {
        var closedExceptions = 0;
        EventHandler<FirstChanceExceptionEventArgs> handler = (_, e) =>
        {
            if (e.Exception is ChannelClosedException)
            {
                Interlocked.Increment(ref closedExceptions);
            }
        };

        AppDomain.CurrentDomain.FirstChanceException += handler;
        EmittedOracleResult result;
        try
        {
            result = EmittedOracle.Evaluate("""
                package P0174ClosedReceive

                let ch = chan[int32](1)
                ch <- 5
                ch.Close()
                var total = <-ch
                for i in 0 ... 500 {
                    total = total + <-ch
                }
                total
                """);
        }
        finally
        {
            AppDomain.CurrentDomain.FirstChanceException -= handler;
        }

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
        Assert.Equal(0, closedExceptions);
    }

    [Fact]
    public void ClosedStringChannel_YieldsNil()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ClosedString

            let ch = chan[string](1)
            ch.Close()
            let v = <-ch
            v == nil
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DoubleClose_Throws_ButDisposeIsIdempotent()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174DoubleClose

            import System.Threading.Channels

            let ch = chan[int32](1)
            ch.Close()
            var threw = false
            try {
                ch.Close()
            } catch (e ChannelClosedException) {
                threw = true
            }

            let disposed = chan[int32](1)
            disposed.Close()
            disposed.Dispose()
            disposed.Dispose()
            threw && disposed.IsClosed
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DirectionalHandles_AreViewsOfOneChannel_AcrossAGoroutine()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Directions

            func produce(results out chan[int32], n int32) {
                for i in 1 ... n + 1 {
                    results <- i
                }
                results.Close()
            }

            func consume(input in chan[int32]) int32 {
                var total = 0
                for i in 0 ... 4 {
                    total = total + <-input
                }
                return total
            }

            let ch = chan[int32](8)
            var total = 0
            scope {
                go produce(ch, 4)
                total = consume(ch)
            }
            total
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void ForeignBclChannel_FlowsIntoChanT_AndItsReaderIntoInChanT()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Foreign

            import System.Threading.Channels

            func drain(ch chan[int32]) int32 {
                return <-ch + <-ch
            }

            func drainReader(r in chan[int32]) int32 {
                return <-r
            }

            let foreign = Channel.CreateBounded[int32](4)
            foreign <- 1
            foreign <- 2
            foreign <- 3
            let viaChannel = drain(foreign)
            let viaReader = drainReader(foreign.Reader)
            foreign.Close()
            let afterClose = <-foreign
            viaChannel * 100 + viaReader * 10 + afterClose
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(330, result.Value);
    }

    [Fact]
    public void UserStructElement_RoundTrips_AndCloseBindsOnSymbolicReceiver()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174UserStruct

            struct Pair {
                var A int32
                var B int32
            }

            func closeIt(ch chan[Pair]) {
                ch.Close()
            }

            let ch = chan[Pair](2)
            ch <- Pair{A: 3, B: 4}
            let p = <-ch
            closeIt(ch)
            let zero = <-ch
            p.A * 10 + p.B + zero.A + zero.B
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(34, result.Value);
    }
}
