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
/// Discrimination witness (ADR-0154): the batch surface is an imported
/// <c>[Suspending]</c> <em>extension</em>, a call shape the binder completes on
/// a different path from a static or instance import. A mutant that drops that
/// completion breaks <see cref="ABatchReceive_IsImplicitlyAwaited"/>: the
/// caller is not coloured suspending, the call keeps its <c>ValueTask[int32]</c>
/// type, and returning it from an <c>int32</c> function is GS0155. A mutant
/// that reports GS0562 from the call's own type rather than the receiver's
/// declaration breaks <see cref="ABufferedChannel_DoesNotWarn"/>.
/// </remarks>
public class Adr0174BatchSurfaceEmitTests
{
    [Fact]
    public void ABatchReceive_IsImplicitlyAwaited()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174BatchAwait
            import System

            func drain(source chan[int32]) int32 {
                let buffer = []int32{0, 0, 0, 0}
                return source.ReceiveBatch(Memory[int32](buffer), 1)
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
                    let sent = ch.SendBatch(ReadOnlyMemory[int32](items))
                    let buffer = []int32{0, 0, 0, 0}
                    let took = ch.ReceiveBatch(Memory[int32](buffer), 4)
                    total = sent + took
                }

                return total
            }

            run()
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
                let took = ch.ReceiveBatch(Memory[int32](buffer), 1)
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
                let took = ch.ReceiveBatch(Memory[int32](buffer), 1)
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
