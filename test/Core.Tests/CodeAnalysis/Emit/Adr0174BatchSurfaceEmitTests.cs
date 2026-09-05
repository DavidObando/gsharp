// <copyright file="Adr0174BatchSurfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D10 from the language side: a batch operation on a channel handle
/// binds, suspends like any other channel operation, and warns when the
/// channel it is given cannot benefit (GS0562).
/// </summary>
/// <remarks>
/// Issue #3954: the batch surface is an ordinary <c>ValueTask[int32]</c>-returning
/// import, not a hand-marked <c>[Suspending]</c> one, so a G# caller writes the
/// <c>await</c> and awaitables keep their C# meaning — <c>.AsTask()</c> on a
/// batch call names the task the way it does in C#. Awaiting is what colours
/// the caller (ADR-0174 D4's <c>await g()</c> row), so a plain <c>func</c> still
/// uses the surface without becoming <c>async</c>.
/// Discrimination witness (ADR-0154): a mutant that restores the implicit await
/// breaks <see cref="ABatchCall_IsAnOrdinaryValueTask"/>, whose whole point is
/// that the call has a nameable task. A mutant that stops <c>await</c> colouring
/// a plain caller breaks <see cref="ABatchReceive_IsAwaitedByAPlainFunc"/> with
/// GS0574. A mutant that reports GS0562 from the call's own type rather than the
/// receiver's declaration breaks <see cref="ABufferedChannel_DoesNotWarn"/>.
/// </remarks>
public class Adr0174BatchSurfaceEmitTests
{
    [Fact]
    public void ABatchReceive_IsAwaitedByAPlainFunc()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174BatchAwait
            import System

            func drain(source chan[int32]) int32 {
                let buffer = []int32{0, 0, 0, 0}
                return await source.ReceiveBatch(Memory[int32](buffer), 1)
            }

            func run() int32 {
                var took = 0
                scope {
                    let ch = chan[int32](64)
                    ch <- 1
                    ch <- 2
                    ch <- 3
                    took = drain(ch)
                }

                return took
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ABatchSend_DeliversEveryElement()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174BatchSend
            import System

            func run() int32 {
                var total = 0
                scope {
                    let ch = chan[int32](8)
                    let items = []int32{1, 2, 3, 4}
                    let sent = await ch.SendBatch(ReadOnlyMemory[int32](items))
                    let buffer = []int32{0, 0, 0, 0}
                    let took = await ch.ReceiveBatch(Memory[int32](buffer), 4)
                    total = sent + took
                }

                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(8, result.Value);
    }

    /// <summary>
    /// Issue #3954: the batch call is an ordinary <c>ValueTask[int32]</c>, so a
    /// caller can NAME it — start the operation, do something else, then await
    /// it — which is the C# idiom (<c>.AsTask().WaitAsync(timeout)</c>) that had
    /// no G# form while the surface auto-awaited. The value proves the task was
    /// the real operation and not a completed placeholder: the second send only
    /// fits after the receive drains the buffer.
    /// </summary>
    [Fact]
    public void ABatchCall_IsAnOrdinaryValueTask()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174BatchTask
            import System
            import System.Threading.Tasks

            async func run() int32 {
                let ch = chan[int32](2)
                let items = []int32{1, 2, 3, 4}
                let pending = ch.SendBatch(ReadOnlyMemory[int32](items)).AsTask()
                let buffer = []int32{0, 0, 0, 0}
                let took = await ch.ReceiveBatch(Memory[int32](buffer), 4)
                return await pending + took
            }

            await run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void ARendezvousChannel_ReportsGS0562()
    {
        var diagnostics = Compile("""
            package P
            import System

            let ch = chan[int32](0)
            scope {
                let buffer = []int32{0, 0}
                let took = await ch.ReceiveBatch(Memory[int32](buffer), 1)
            }
            """);

        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0562");
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity);
        Assert.Contains("'ch'", diagnostic.Message);
    }

    [Fact]
    public void ABufferedChannel_DoesNotWarn()
    {
        var diagnostics = Compile("""
            package P
            import System

            let ch = chan[int32](64)
            scope {
                let buffer = []int32{0, 0}
                let took = await ch.ReceiveBatch(Memory[int32](buffer), 1)
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0562");
    }

    [Fact]
    public void ARendezvousChannel_WarnsForTheNonParkingFormsToo()
    {
        var diagnostics = Compile("""
            package P
            import System

            let ch = chan[int32](0)
            let buffer = []int32{0, 0}
            let took = ch.TryReceiveBatch(Span[int32](buffer))
            """);

        Assert.Single(diagnostics, d => d.Id == "GS0562");
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> Compile(string source)
        => EmittedOracle.CompileDiagnostics(new Compilation(SyntaxTree.Parse(source)));
}
