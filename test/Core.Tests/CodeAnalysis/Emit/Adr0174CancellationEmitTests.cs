// <copyright file="Adr0174CancellationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D7 through real emitted execution: a channel operation parked
/// inside a <c>scope</c> unwinds when the block is cancelled — which is what
/// makes a failing goroutine collapse its siblings instead of leaving them
/// parked forever — while an operation that already committed keeps its value.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that binds channel operations
/// against the default token instead of the block's <c>ctx</c> (the shape
/// before D7) leaves the parked receive in
/// <see cref="ParkedReceive_InACancelledScope_Unwinds"/> waiting for the
/// rescue close, so the program reports the closed channel's zero value
/// instead of the cancellation — the test distinguishes those two outcomes
/// rather than hanging, so the mutant fails fast.
/// </remarks>
public class Adr0174CancellationEmitTests
{
    [Fact]
    public void ParkedReceive_InACancelledScope_Unwinds()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Cancel
            import System
            import System.Threading

            func fail() {
                Thread.Sleep(20)
                throw Exception("child failed")
            }

            // Bounds the test under a mutant that never cancels the receive:
            // closing the channel releases it with the zero value instead.
            func rescue(ch chan[int32]) {
                Thread.Sleep(3000)
                ch.Close()
            }

            func run() string {
                let ch = chan[int32]()
                var outcome = "parked"
                try {
                    scope {
                        go fail()
                        go rescue(ch)
                        try {
                            let v = <-ch
                            outcome = "received " + v.ToString()
                        } catch (cancelled OperationCanceledException) {
                            outcome = "cancelled"
                        }
                    }
                } catch (scopeFailure Exception) {
                    outcome = outcome + " / " + scopeFailure.GetType().Name
                }

                return outcome
            }

            run()
            """);

        // The rendezvous channel warns by design (GS0548); nothing may error.
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("cancelled / ScopeException", result.Value);
    }

    [Fact]
    public void CommittedReceive_IsNotUndoneByALaterCancellation()
    {
        // D7's linearization rule: cancellation wins only before the transfer
        // commits. The value is already in the buffer, so the receive keeps it
        // even though the block is cancelled immediately afterwards.
        var result = EmittedOracle.Evaluate("""
            package P0174Committed
            import System
            import System.Threading

            func fail() {
                Thread.Sleep(20)
                throw Exception("child failed")
            }

            func run() int32 {
                let ch = chan[int32](1)
                ch <- 41
                var got = 0
                try {
                    scope {
                        go fail()
                        got = <-ch
                        Thread.Sleep(60)
                    }
                } catch (scopeFailure Exception) {
                    got = got + 1
                }

                return got
            }

            run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void OperationsOutsideAScope_AreNotCancelled()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174NoScope
            func run() int32 {
                let ch = chan[int32](1)
                ch <- 7
                return <-ch
            }

            run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }
}
