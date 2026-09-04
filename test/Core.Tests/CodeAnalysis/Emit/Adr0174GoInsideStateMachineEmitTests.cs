// <copyright file="Adr0174GoInsideStateMachineEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// A <c>go</c> statement inside a state-machine body — an <c>async func</c>, a
/// <c>suspend func</c>, or a plain function that inference made suspending
/// (ADR-0174 D4) — reaches the emitter as a node the async rewriters rebuilt
/// (its operand's locals became hoisted-field reads). The closure synthesized
/// for it is found by the statement's syntax, not by node identity. Before
/// this, the shape was a GS9998 ("Go statement has no synthesized display
/// class") for every <c>async func</c> containing <c>go</c>.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that drops the syntax-keyed
/// lookup in <c>ClosureEmitter.TryGetGoClosure</c> reproduces the GS9998 on
/// every test here.
/// </remarks>
public class Adr0174GoInsideStateMachineEmitTests
{
    [Fact]
    public void Go_InsideAsyncFunc_CapturingHoistedLocals_Runs()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174GoAsync
            import System.Threading.Tasks

            async func run() int32 {
                let ch = chan[int32](1)
                let x = 10
                let send = func() {
                    ch <- x
                }
                go send()
                await Task.Yield()
                return <-ch
            }

            run().Result
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Go_InsideAnInferredSuspendingFunc_Runs()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174GoInferred

            func produce(ch out chan[int32], n int32) {
                for i in 1 ... n + 1 {
                    ch <- i
                }
                ch.Close()
            }

            func sum(n int32) int32 {
                let ch = chan[int32](2)
                go produce(ch, n)
                var total = 0
                for v in ch {
                    total = total + v
                }
                return total
            }

            sum(4)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Go_InsideASuspendFunc_WithScope_Joins()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174GoSuspendScope

            func send(ch out chan[int32], v int32) {
                ch <- v
            }

            suspend func gather() int32 {
                let ch = chan[int32](3)
                scope {
                    go send(ch, 1)
                    go send(ch, 2)
                    go send(ch, 3)
                }
                return <-ch + <-ch + <-ch
            }

            gather()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }
}
