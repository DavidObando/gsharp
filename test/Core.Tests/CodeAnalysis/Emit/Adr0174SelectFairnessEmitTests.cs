// <copyright file="Adr0174SelectFairnessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D8: <c>select</c> chooses uniformly at random among the arms that
/// are ready, the way Go does. The old lowering probed receive arms in source
/// order and then send arms, so the first arm written always won — a bias
/// programs could come to depend on.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that probes arms in source order
/// (the shape before this ADR) breaks
/// <see cref="TwoReadyArms_AreBothChosen_OverManyIterations"/>, which fails as
/// soon as either arm wins fewer than a quarter of the rounds. The margin is
/// wide enough that a fair implementation cannot fail it by chance: over 2000
/// rounds a fair choice lands each arm near 1000, and the bound is 500.
/// </remarks>
public class Adr0174SelectFairnessEmitTests
{
    [Fact]
    public void TwoReadyArms_AreBothChosen_OverManyIterations()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174SelectFair
            func run() string {
                let a = chan[int32](1)
                let b = chan[int32](1)
                var fromA = 0
                var fromB = 0
                for i in 0 ... 2000 {
                    a <- 1
                    b <- 2
                    select {
                    case let v = <-a {
                        fromA = fromA + 1
                        let drained = <-b
                    }
                    case let w = <-b {
                        fromB = fromB + 1
                        let drained = <-a
                    }
                    }
                }

                if fromA > 500 && fromB > 500 {
                    return "fair"
                }

                return "biased a=" + fromA.ToString() + " b=" + fromB.ToString()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("fair", result.Value);
    }

    [Fact]
    public void UserStructElements_TransferThroughSelect_WithoutBoxingConfusion()
    {
        // A same-compilation element type has no reference-context CLR type, so
        // the waiter's generic methods close over `object` and the real type
        // travels symbolically. The emitted `TakeValue[Pair]` already returns
        // `Pair`; widening it as if `object` had come back unboxes a value that
        // was never boxed, which the JIT turns into a segmentation fault rather
        // than an exception (issue #2965, found while landing D8).
        var result = EmittedOracle.Evaluate("""
            package P0174SelectStruct
            data struct Pair(Value int32)

            func run() int32 {
                let ch = chan[Pair](1)
                var sent = 0

                select {
                case ch <- Pair(41) {
                    sent = 1
                }
                }

                select {
                case let got = <-ch {
                    return got.Value + sent
                }
                }
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ASelectWithADefaultArm_TakesTheDefault_WhenNothingIsReady()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174SelectDefault
            func run() int32 {
                let ch = chan[int32](1)
                var taken = 0
                select {
                case let v = <-ch {
                    taken = 1
                }
                default {
                    taken = 2
                }
                }

                ch <- 5
                select {
                case let v = <-ch {
                    taken = taken + v * 10
                }
                default {
                    taken = taken + 100
                }
                }

                return taken
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(52, result.Value);
    }

    [Fact]
    public void ASelectWithNoReadyArm_ParksUntilAGoroutineSends()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174SelectPark
            import System.Threading

            func sendLater(ch out chan[int32]) {
                Thread.Sleep(60)
                ch <- 41
            }

            func run() int32 {
                let a = chan[int32]()
                let b = chan[int32]()
                scope {
                    go sendLater(b)
                    select {
                    case let v = <-a {
                        return v
                    }
                    case let w = <-b {
                        return w + 1
                    }
                    }
                }

                return -1
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }
}
