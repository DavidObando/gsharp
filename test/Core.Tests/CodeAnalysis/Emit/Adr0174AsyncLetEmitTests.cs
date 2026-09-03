// <copyright file="Adr0174AsyncLetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D15: <c>async let name = expr</c> starts <c>expr</c> as a child of
/// the enclosing <c>scope</c> and binds <c>name</c> to its eventual result.
/// The binding is a value of type <c>R</c>, never a handle, so a spawn cannot
/// outlive the block that owns it; every read is <c>await name</c>.
/// </summary>
/// <remarks>
/// <para>Discrimination witnesses (ADR-0154), all run against the mutants named:</para>
/// <list type="bullet">
/// <item>
/// A mutant that binds <c>async let</c> as an ordinary eager <c>let</c> breaks
/// <see cref="TwoChildren_CompleteAMutualRendezvous"/>: the initializer runs
/// where it is written, so the first binding blocks on a rendezvous the second
/// would have satisfied. It fails before that, at compile time — the binding is
/// then an <c>int32</c> and <c>await</c> on it is GS0133 — which is the same
/// mutant, caught earlier.
/// </item>
/// <item>
/// A mutant that drops the scope-exit join breaks
/// <see cref="UnawaitedChild_IsCancelledAtScopeExit"/>, which then never
/// terminates: the child stays parked on a channel nobody will ever write to.
/// </item>
/// <item>
/// A mutant whose cell does not register with the enclosing frame breaks every
/// test here at once — the frame's pending count underflows and its exit
/// throws.
/// </item>
/// <item>
/// A mutant that discards the child's result on the way to the goroutine (the
/// shaping an ordinary <c>go</c> wants) produces an
/// <c>InvalidProgramException</c> in the synthesized body: the cell's
/// <c>Run</c> is handed a <c>ValueTask</c> where it expects a
/// <c>ValueTask[R]</c>.
/// </item>
/// <item>
/// A mutant that runs the child under the enclosing block's context rather
/// than its own cell's breaks
/// <see cref="UnawaitedChild_IsCancelledAtScopeExit"/>: cancelling the cell
/// then unwinds nothing, because the child never observed that context.
/// </item>
/// </list>
/// </remarks>
public class Adr0174AsyncLetEmitTests
{
    [Fact]
    public void TwoChildren_CompleteAMutualRendezvous()
    {
        // Neither child can finish alone: each waits on a rendezvous the other
        // satisfies. Running the initializers where they are written deadlocks.
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetConcurrent
            let left = chan[int32]()
            let right = chan[int32]()

            func toLeft() int32 {
                left <- 1
                return <-right
            }

            func toRight() int32 {
                let v = <-left
                right <- 2
                return v
            }

            func run() int32 {
                var total = 0
                scope {
                    async let a = toLeft()
                    async let b = toRight()
                    total = (await a) + (await b)
                }

                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ReadTwice_ReturnsTheCompletedValue()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetTwice
            func one() int32 {
                return 7
            }

            func run() int32 {
                var total = 0
                scope {
                    async let c = one()
                    total = (await c) + (await c)
                }

                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(14, result.Value);
    }

    [Fact]
    public void UnawaitedChild_IsCancelledAtScopeExit()
    {
        // The child parks on a channel nobody writes to. The block cancels and
        // joins it at exit rather than waiting forever.
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetUnawaited
            let never = chan[int32]()

            func parked() int32 {
                return <-never
            }

            func run() string {
                scope {
                    async let stuck = parked()
                }

                return "exited"
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("exited", result.Value);
    }

    [Fact]
    public void UnawaitedFailure_ReachesTheScope()
    {
        // A failure nobody read is folded into the scope's exit, not dropped.
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetUnawaitedFailure
            import System

            func boom() int32 {
                throw Exception("child failed")
            }

            func run() string {
                try {
                    scope {
                        async let bad = boom()
                    }
                } catch (e Exception) {
                    return e.GetType().Name
                }

                return "no failure"
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("ScopeException", result.Value);
    }

    [Fact]
    public void AwaitedFailure_SurfacesAtTheAwait()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetAwaitedFailure
            import System

            func boom() int32 {
                throw Exception("child failed")
            }

            func run() string {
                try {
                    scope {
                        async let bad = boom()
                        let v = await bad
                    }
                } catch (e Exception) {
                    return e.Message
                }

                return "no failure"
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("child failed", result.Value);
    }

    [Fact]
    public void AFailingChild_DoesNotCancelItsSiblings()
    {
        // Swift's rule, and the reason a cell does not report its failure to
        // the frame until scope exit: catching one `async let` must not kill
        // the ones running beside it.
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetSiblings
            import System

            func boom() int32 {
                throw Exception("child failed")
            }

            func slow() int32 {
                let ch = chan[int32](1)
                ch <- 5
                return <-ch
            }

            func run() int32 {
                var total = 0
                scope {
                    async let bad = boom()
                    async let good = slow()
                    try {
                        total = await bad
                    } catch (e Exception) {
                        total = -1
                    }

                    total = total + (await good)
                }

                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void TheBindingHasTheChildsResultType()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetType
            func greet() string {
                return "hello"
            }

            func run() int32 {
                var length = 0
                scope {
                    async let text = greet()
                    length = (await text).Length
                }

                return length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void AUserStructResult_TravelsThroughTheCell()
    {
        // A same-compilation result type has no reference-context CLR type, so
        // the cell closes over `object` and the real type travels symbolically
        // — the same shape as a channel element (issue #2965).
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetStruct
            data struct Pair(Value int32)

            func make() Pair {
                return Pair(41)
            }

            func run() int32 {
                var got = 0
                scope {
                    async let p = make()
                    got = (await p).Value
                }

                return got
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(41, result.Value);
    }

    [Fact]
    public void NestedScopes_EachOwnTheirOwnChildren()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLetNested
            func two() int32 {
                return 2
            }

            func run() int32 {
                var total = 0
                scope {
                    async let outer = two()
                    scope {
                        async let inner = two()
                        total = total + (await inner)
                    }

                    total = total + (await outer)
                }

                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(4, result.Value);
    }
}
