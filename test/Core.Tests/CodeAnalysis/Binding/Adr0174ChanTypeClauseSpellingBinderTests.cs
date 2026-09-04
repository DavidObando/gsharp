// <copyright file="Adr0174ChanTypeClauseSpellingBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D2 binder half of the respelling: the recovered legacy
/// <c>chan T</c> binds to the very same <see cref="ChannelTypeSymbol"/> the
/// canonical <c>chan[T]</c> does (GS0567 is the only diagnostic), directions
/// bind to the reader/writer symbols, and — the witness that the respelling
/// removed the ambiguity rather than relocating it — <c>chan[int32]?</c> and
/// <c>chan[int32?]</c> bind to two distinct types.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that binds <c>chan[int32]?</c>
/// as a channel of nullable, or <c>chan[int32?]</c> as a nullable channel,
/// breaks <see cref="NullableChannel_And_ChannelOfNullable_AreDistinctTypes"/>
/// — the assignment that must succeed on one fails, or the one that must fail
/// on the other succeeds.
/// </remarks>
public class Adr0174ChanTypeClauseSpellingBinderTests
{
    [Fact]
    public void LegacyAndCanonical_BindToTheSameSymbol()
    {
        var result = Bind("""
            package P
            func main() {
                var legacy chan int32 = chan[int32](1)
                var canonical chan[int32] = legacy
                canonical <- 1
                let v = <-legacy
            }
            """);
        var ids = result.Diagnostics.Select(d => d.Id).Distinct().ToArray();
        Assert.Equal(new[] { "GS0567" }, ids);
    }

    [Fact]
    public void Directions_BindToReaderAndWriterTypes()
    {
        var result = Bind("""
            package P
            func consume(r in chan[int32]) int32 {
                return <-r
            }
            func produce(w out chan[int32]) {
                w <- 1
            }
            func main() {
                let ch = chan[int32](1)
                produce(ch)
                let v = consume(ch)
            }
            """);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SendOnReceiveOnly_ReportsGS0549_AndReceiveFromSendOnly_ReportsGS0550()
    {
        var result = Bind("""
            package P
            func bad(r in chan[int32], w out chan[int32]) {
                r <- 1
                let v = <-w
            }
            """);
        var ids = result.Diagnostics.Select(d => d.Id).OrderBy(x => x).ToArray();
        Assert.Equal(new[] { "GS0549", "GS0550" }, ids);
        var send = result.Diagnostics.Single(d => d.Id == "GS0549");
        Assert.Equal("<-", send.Location.Text.ToString(send.Location.Span));
        Assert.Contains("in chan[int32]", send.Message);
        var receive = result.Diagnostics.Single(d => d.Id == "GS0550");
        Assert.Contains("out chan[int32]", receive.Message);
    }

    [Fact]
    public void Directional_CannotWiden_AndCannotCross()
    {
        var result = Bind("""
            package P
            func widen(r in chan[int32]) chan[int32] {
                return r
            }
            func cross(r in chan[int32]) out chan[int32] {
                return r
            }
            """);
        Assert.Equal(2, result.Diagnostics.Count(d => d.Severity == DiagnosticSeverity.Error));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0549" or "GS0550" or "GS0567");
    }

    [Fact]
    public void NullableChannel_And_ChannelOfNullable_AreDistinctTypes()
    {
        // `chan[int32]?` may be nil; `chan[int32?]` may carry nil elements.
        var ok = Bind("""
            package P
            func main() {
                var maybe chan[int32]? = nil
                var elems chan[int32?] = chan[int32?](1)
                elems <- nil
            }
            """);
        Assert.Empty(ok.Diagnostics);

        var nilChannelOfNonNullable = Bind("""
            package P
            func main() {
                var ch chan[int32] = nil
            }
            """);
        Assert.NotEmpty(nilChannelOfNonNullable.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error));

        var nilElementOnNonNullable = Bind("""
            package P
            func main() {
                var ch chan[int32]? = chan[int32](1)
                ch <- nil
            }
            """);
        Assert.NotEmpty(nilElementOnNonNullable.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error));
    }

    [Fact]
    public void ConstructedChannel_HasTheRuntimeClassType_AndItsMembers()
    {
        var result = Bind("""
            package P
            func main() {
                let ch = chan[int32](4)
                let n = ch.Length()
                let c = ch.Capacity
                ch.Close()
                var handle chan[int32] = ch
            }
            """);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void LengthAndCapacity_AreNotMembersOfTheTypeClause()
    {
        // D12: `Length()`/`Capacity` exist only on the constructed Chan[T]; a
        // `chan[T]` handle (which may be any foreign Channel<T>) has neither —
        // ordinary member-not-found, no channel-specific diagnostic.
        var result = Bind("""
            package P
            func peek(ch chan[int32]) int32 {
                return ch.Length()
            }
            """);
        Assert.NotEmpty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id.StartsWith("GS05", System.StringComparison.Ordinal));
    }

    [Fact]
    public void RendezvousConstruction_ReportsGS0548Advisory()
    {
        var result = Bind("""
            package P
            func main() {
                let ch = chan[int32]()
            }
            """);
        var d = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0548", d.Id);
        Assert.Equal(DiagnosticSeverity.Warning, d.Severity);
        Assert.Contains("Chan.Unbounded[int32]()", d.Message);
    }

    [Fact]
    public void RetiredClose_ReportsGS0566_NamingTheMemberSpelling()
    {
        var result = Bind("""
            package P
            func main() {
                let ch = chan[int32](1)
                close(ch)
            }
            """);
        var d = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0566", d.Id);
        Assert.Contains("use 'ch.Close()' instead", d.Message);
        Assert.Equal("close(ch)", d.Location.Text.ToString(d.Location.Span));
    }

    [Fact]
    public void ChannelProgram_CompilesWithNoImport()
    {
        // D13: the syntax is the language; the library namespace is implicit.
        var result = Bind("""
            package P
            func worker(jobs in chan[int32], results out chan[int32]) {
                results <- <-jobs
            }
            func main() {
                let jobs = chan[int32](1)
                let results = Chan.Unbounded[int32]()
                scope {
                    go worker(jobs, results)
                    jobs <- 41
                }
                let v = <-results
                results.Close()
            }
            """);
        Assert.Empty(result.Diagnostics);
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, Compilation Compilation) Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return (EmittedOracle.CompileDiagnostics(compilation), compilation);
    }
}
