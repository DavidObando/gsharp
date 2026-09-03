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
/// A variadic function is the one shape that cannot be given a context
/// implicitly: <c>...T</c> must stay positionally last, and an optional
/// parameter placed before it is not skippable — a caller writing
/// <c>f(ch, 2, 3)</c> either fails to compile or, when the variadic element
/// type is compatible with <c>Context</c>, silently loses its first argument
/// to it. Declaring <c>ctx Context</c> before the variadic is the supported
/// way, and it is exercised here.
/// </remarks>
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
    public void ParkedReceive_InsideACallee_UnwindsWithTheCallersScope()
    {
        // D7's cross-call half: `worker` has no lexical scope of its own, so it
        // can only observe the caller's cancellation through the ambient
        // context the compiler threads into it.
        var result = EmittedOracle.Evaluate("""
            package P0174CalleeCancel
            import System
            import System.Threading

            func fail() {
                Thread.Sleep(20)
                throw Exception("child failed")
            }

            func rescue(ch chan[int32]) {
                Thread.Sleep(3000)
                ch.Close()
            }

            func worker(ch in chan[int32]) string {
                try {
                    let v = <-ch
                    return "received " + v.ToString()
                } catch (cancelled OperationCanceledException) {
                    return "cancelled"
                }
            }

            func run() string {
                let ch = chan[int32]()
                var outcome = "parked"
                try {
                    scope {
                        go fail()
                        go rescue(ch)
                        outcome = worker(ch)
                    }
                } catch (scopeFailure Exception) {
                    outcome = outcome + " / " + scopeFailure.GetType().Name
                }

                return outcome
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("cancelled / ScopeException", result.Value);
    }

    [Fact]
    public void ADeclaredContextParameter_CarriesTheCallersCancellation()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174DeclaredCtx
            import System
            import System.Threading
            import Gsharp.Concurrency

            func fail() {
                Thread.Sleep(20)
                throw Exception("child failed")
            }

            func rescue(ch chan[int32]) {
                Thread.Sleep(3000)
                ch.Close()
            }

            func worker(ch in chan[int32], ctx Context) string {
                try {
                    let v = <-ch
                    return "received " + v.ToString()
                } catch (cancelled OperationCanceledException) {
                    return "cancelled"
                }
            }

            func run() string {
                let ch = chan[int32]()
                var outcome = "parked"
                try {
                    scope {
                        go fail()
                        go rescue(ch)
                        outcome = worker(ch, ctx)
                    }
                } catch (scopeFailure Exception) {
                    outcome = outcome + " / " + scopeFailure.GetType().Name
                }

                return outcome
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("cancelled / ScopeException", result.Value);
    }

    [Fact]
    public void AVariadicSuspendingFunction_StillRuns()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Variadic
            func sumAll(ch in chan[int32], extras ...int32) int32 {
                var total = <-ch
                for e in extras {
                    total = total + e
                }

                return total
            }

            let ch = chan[int32](1)
            ch <- 1
            sumAll(ch, 2, 3)
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void AVariadicFunction_WithADeclaredContext_IsCancellable()
    {
        // The documented way to get cancellation into a variadic function: put
        // `ctx Context` before the variadic parameter yourself. The compiler
        // cannot inject one there — see the class remarks.
        var result = EmittedOracle.Evaluate("""
            package P0174VariadicCtx
            import System
            import System.Threading
            import Gsharp.Concurrency

            func fail() {
                Thread.Sleep(20)
                throw Exception("child failed")
            }

            func rescue(ch chan[int32]) {
                Thread.Sleep(3000)
                ch.Close()
            }

            func sumAll(ch in chan[int32], ctx Context, extras ...int32) string {
                try {
                    var total = <-ch
                    for e in extras {
                        total = total + e
                    }

                    return "received " + total.ToString()
                } catch (cancelled OperationCanceledException) {
                    return "cancelled"
                }
            }

            func run() string {
                let ch = chan[int32]()
                var outcome = "parked"
                try {
                    scope {
                        go fail()
                        go rescue(ch)
                        outcome = sumAll(ch, ctx, 2, 3)
                    }
                } catch (scopeFailure Exception) {
                    outcome = outcome + " / " + scopeFailure.GetType().Name
                }

                return outcome
            }

            run()
            """);

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
