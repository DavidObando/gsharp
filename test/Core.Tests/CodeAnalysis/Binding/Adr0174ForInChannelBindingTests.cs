// <copyright file="Adr0174ForInChannelBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D3: <c>for v in ch { … }</c> drains a channel until it is closed.
/// The channel is decided before the enumerator probe (a channel handle has
/// no <c>GetEnumerator</c>), the collection is evaluated once, and the loop
/// takes the <c>while let</c> shape around a two-value receive — no new
/// iteration kind, no emitter change. Foreign <c>Channel&lt;T&gt;</c> handles
/// take the same path through the runtime's fallback.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that re-evaluates the
/// collection expression at every check (the <c>while let</c> clause's rule)
/// breaks <see cref="Collection_IsEvaluatedOnce"/>, which counts the calls of
/// the function producing the channel.
/// </remarks>
public class Adr0174ForInChannelBindingTests
{
    [Fact]
    public void DrainsUntilClosed_FromAGoroutineProducer()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ForInDrain
            func produce(w out chan[int32], n int32) {
                for i in 1 ... n {
                    w <- i
                }
                w.Close()
            }
            let ch = chan[int32](2)
            go produce(ch, 5)
            var sum = 0
            for v in ch {
                sum = sum + v
            }
            sum
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void InChanParameter_Drains()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ForInParam
            func total(r in chan[int32]) int32 {
                var s = 0
                for v in r {
                    s = s + v
                }
                return s
            }
            let ch = chan[int32](3)
            ch <- 1
            ch <- 2
            ch <- 3
            ch.Close()
            total(ch)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void Collection_IsEvaluatedOnce()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ForInOnce
            let ch = chan[int32](2)
            ch <- 1
            ch <- 2
            ch.Close()
            var calls = 0
            let pick = func() chan[int32] {
                calls = calls + 1
                return ch
            }
            var sum = 0
            for v in pick() {
                sum = sum + v
            }
            calls * 100 + sum
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(103, result.Value);
    }

    [Fact]
    public void BreakAndContinue_Work()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ForInJumps
            let ch = chan[int32](6)
            ch <- 1
            ch <- 2
            ch <- 3
            ch <- 4
            ch <- 5
            ch <- 6
            ch.Close()
            var sum = 0
            for v in ch {
                if v == 2 {
                    continue
                }
                if v == 5 {
                    break
                }
                sum = sum + v
            }
            sum * 10 + ch.Length()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(81, result.Value);
    }

    [Fact]
    public void NullableElement_NilIsDelivered()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ForInNil
            let ch = chan[string?](2)
            ch <- nil
            ch <- "x"
            ch.Close()
            var seen = 0
            var nils = 0
            for s in ch {
                seen = seen + 1
                if s == nil {
                    nils = nils + 1
                }
            }
            seen * 10 + nils
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(21, result.Value);
    }

    [Fact]
    public void TupleElement_DeconstructsPerIteration()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ForInTuple
            let ch = chan[(int32, int32)](2)
            ch <- (1, 2)
            ch <- (3, 4)
            ch.Close()
            var s = 0
            for (a, b) in ch {
                s = s + a * b
            }
            s
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(14, result.Value);
    }

    [Fact]
    public void ForeignBclChannel_Drains()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ForInForeign
            import System.Threading.Channels
            let foreign = Channel.CreateBounded[int32](3)
            foreign <- 1
            foreign <- 2
            foreign <- 3
            foreign.Close()
            var sum = 0
            for v in foreign {
                sum = sum + v
            }
            sum
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ForeignBclReader_Drains()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ForInForeignReader
            import System.Threading.Channels
            let foreign = Channel.CreateBounded[int32](2)
            foreign <- 5
            foreign <- 6
            foreign.Close()
            var sum = 0
            for v in foreign.Reader {
                sum = sum + v
            }
            sum
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void SendOnlyHandle_ReportsGS0550()
    {
        var (diagnostics, _) = Bind("""
            package P
            func f(w out chan[int32]) {
                for v in w {
                }
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0550", diagnostic.Id);
    }

    [Fact]
    public void TwoLoopVariables_ReportGS0554()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let ch = chan[int32](1)
                for k, v in ch {
                }
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0554", diagnostic.Id);
        Assert.Contains("one loop variable", diagnostic.Message);
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, Compilation Compilation) Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return (EmittedOracle.CompileDiagnostics(compilation), compilation);
    }
}
