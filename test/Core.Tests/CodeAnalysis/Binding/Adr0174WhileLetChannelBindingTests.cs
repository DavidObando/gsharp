// <copyright file="Adr0174WhileLetChannelBindingTests.cs" company="GSharp">
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
/// ADR-0174 D3: <c>while let v = &lt;-ch { … }</c> loops until the channel is
/// closed. The clause is recognized syntactically (a prefix <c>&lt;-</c>
/// initializer) and bypasses ADR-0163's nullable-stripping clause binder, so
/// the binding has the element type exactly and a <c>nil</c> element is
/// delivered rather than ending the loop. Clauses gate in source order: a
/// closed channel in the first clause never receives from the second.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154): a mutant that routes the channel
/// clause through <c>IfLetBindingSupport.BindBindingClause</c> (stripping the
/// element's nullability and testing the element against <c>nil</c>) breaks
/// <see cref="NullableElement_NilIsDelivered_NotTreatedAsClosed"/>; a mutant
/// that evaluates every clause before testing any gate breaks
/// <see cref="Clauses_ShortCircuit_InSourceOrder"/>, where the second channel
/// would lose its buffered value.
/// </remarks>
public class Adr0174WhileLetChannelBindingTests
{
    [Fact]
    public void DrainsUntilClosed_ThenExits()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174WhileLetDrain
            let ch = chan[int32](3)
            ch <- 1
            ch <- 2
            ch <- 3
            ch.Close()
            var sum = 0
            while let v = <-ch {
                sum = sum + v
            }
            sum
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void NullableElement_NilIsDelivered_NotTreatedAsClosed()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174WhileLetNil
            let ch = chan[string?](3)
            ch <- "a"
            ch <- nil
            ch <- "b"
            ch.Close()
            var seen = 0
            var nils = 0
            while let s = <-ch {
                seen = seen + 1
                if s == nil {
                    nils = nils + 1
                }
            }
            seen * 10 + nils
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(31, result.Value);
    }

    [Fact]
    public void Clauses_ShortCircuit_InSourceOrder()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174WhileLetShortCircuit
            let x = chan[int32](1)
            let y = chan[int32](1)
            x.Close()
            y <- 5
            var iterations = 0
            while let a = <-x, let b = <-y {
                iterations = iterations + 1
            }
            iterations * 10 + y.Length()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ChannelClause_MixesWithNilCheckClause()
    {
        // ADR-0163 clauses are independent (a later initializer does not see an
        // earlier binding), so the nil-check clause counts its own calls: it
        // yields nil on the third evaluation and ends the loop after two
        // iterations even though the channel still holds a value.
        var result = EmittedOracle.Evaluate("""
            package P0174WhileLetMixed
            var probes = 0
            let label = func() string? {
                probes = probes + 1
                if probes == 3 {
                    return nil
                }
                return "n"
            }
            let ch = chan[int32](3)
            ch <- 1
            ch <- 2
            ch <- 3
            ch.Close()
            var count = 0
            while let v = <-ch, let s = label() {
                count = count + s.Length + v
            }
            count * 10 + ch.Length()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void ExplicitTypeClause_ConvertsTheElement()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174WhileLetTyped
            let ch = chan[int32](2)
            ch <- 4
            ch <- 5
            ch.Close()
            var total int64 = 0
            while let v int64 = <-ch {
                total = total + v
            }
            total
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(9L, result.Value);
    }

    [Fact]
    public void BreakAndContinue_Work()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174WhileLetJumps
            let ch = chan[int32](6)
            ch <- 1
            ch <- 2
            ch <- 3
            ch <- 4
            ch <- 5
            ch <- 6
            ch.Close()
            var sum = 0
            while let v = <-ch {
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
    public void InChanParameter_InsideIterator_YieldsEveryElement()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174WhileLetIterator
            func drain(r in chan[int32]) sequence[int32] {
                while let v = <-r {
                    yield v
                }
            }
            let ch = chan[int32](2)
            ch <- 3
            ch <- 4
            ch.Close()
            var sum = 0
            for v in drain(ch) {
                sum = sum + v
            }
            sum
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Initializer_IsTheChannelItself_ReportsGS0555_NotGS0296()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let ch = chan[int32](1)
                while let v = ch {
                }
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0555", diagnostic.Id);
        Assert.Contains("while let v = <-ch", diagnostic.Message);
    }

    [Fact]
    public void Initializer_IsANonNullableNonChannel_StillReportsGS0296()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let n = 3
                while let v = n {
                }
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0296", diagnostic.Id);
    }

    [Fact]
    public void FromSendOnlyHandle_ReportsGS0550()
    {
        var (diagnostics, _) = Bind("""
            package P
            func f(w out chan[int32]) {
                while let v = <-w {
                }
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0550", diagnostic.Id);
    }

    [Fact]
    public void Binding_IsReadOnly()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let ch = chan[int32](1)
                while let v = <-ch {
                    v = 2
                }
            }
            """);

        Assert.NotEmpty(diagnostics);
        Assert.All(diagnostics, d => Assert.Contains("v", d.Message));
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, Compilation Compilation) Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return (EmittedOracle.CompileDiagnostics(compilation), compilation);
    }
}
