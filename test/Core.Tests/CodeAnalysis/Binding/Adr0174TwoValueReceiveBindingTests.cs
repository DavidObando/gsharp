// <copyright file="Adr0174TwoValueReceiveBindingTests.cs" company="GSharp">
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
/// ADR-0174 D3: the two-value receive. A prefix <c>&lt;-ch</c> in a tuple
/// deconstruction (<c>let (v, ok) = &lt;-ch</c>) or a two-target
/// multi-assignment (<c>v, ok = &lt;-ch</c>) binds as the <c>(T, bool)</c>
/// tuple of <c>ChannelOps.Receive2&lt;T&gt;</c>: the element (its zero value
/// once the channel is closed) and whether the channel delivered it. ADR-0168's
/// mixed rule is untouched — <c>let v, ok = &lt;-ch</c> declares <c>v</c> and
/// assigns an existing <c>ok</c> (ADR-0174 errata 9).
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that binds the deconstruction
/// initializer through the single-value receive (element-typed, not a tuple)
/// breaks every fact here with a deconstruction-arity diagnostic; a mutant
/// that drops the <c>ok</c> flag on close breaks
/// <see cref="NullableElement_NilWithOkTrue_IsDistinguishableFromClosed"/>,
/// where a delivered <c>nil</c> and a closed channel produce the same element
/// and differ only in the flag.
/// </remarks>
public class Adr0174TwoValueReceiveBindingTests
{
    private const string Flag = """
        func flag(b bool) int32 {
            if b {
                return 1
            }
            return 0
        }
        """;

    [Fact]
    public void TupleDeconstruction_DeliveredThenClosed_ReportsOkThenNotOk()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P0174TwoValue
            {{Flag}}
            let ch = chan[int32](1)
            ch <- 9
            let (v1, ok1) = <-ch
            ch.Close()
            let (v2, ok2) = <-ch
            flag(ok1) * 1000 + v1 * 10 + flag(ok2) * 100 + v2
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1090, result.Value);
    }

    [Fact]
    public void VarDeconstruction_BindsMutableNames()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P0174TwoValueVar
            {{Flag}}
            let ch = chan[int32](1)
            ch <- 4
            var (v, ok) = <-ch
            v = v + 1
            ok = !ok
            v * 10 + flag(ok)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void MultiTarget_AssignsExistingVariables()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P0174TwoValueAssign
            {{Flag}}
            let ch = chan[int32](1)
            ch <- 5
            var v = 0
            var ok = false
            v, ok = <-ch
            v * 10 + flag(ok)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(51, result.Value);
    }

    [Fact]
    public void MixedLetTarget_DeclaresFirst_AssignsExistingSecond()
    {
        // ADR-0168's rule survives: `let v, ok = <-ch` declares only `v`.
        var result = EmittedOracle.Evaluate($$"""
            package P0174TwoValueMixed
            {{Flag}}
            let ch = chan[int32](1)
            ch <- 7
            var ok = false
            let v, ok = <-ch
            v * 10 + flag(ok)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(71, result.Value);
    }

    [Fact]
    public void MixedLetTarget_WithUndeclaredSecond_IsTheOrdinaryUndefinedVariable()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let ch = chan[int32](1)
                let v, ok = <-ch
            }
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0125" && d.Message.Contains("'ok'"));
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0554");
    }

    [Fact]
    public void ThreeNames_InDeconstruction_ReportGS0554()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let ch = chan[int32](1)
                let (a, b, c) = <-ch
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0554", diagnostic.Id);
        Assert.Contains("two names", diagnostic.Message);
        Assert.Contains("not 3", diagnostic.Message);
    }

    [Fact]
    public void ThreeTargets_InMultiAssignment_ReportGS0554()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let ch = chan[int32](1)
                var a = 0
                var b = false
                var c = 0
                a, b, c = <-ch
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0554", diagnostic.Id);
        Assert.Contains("two targets", diagnostic.Message);
    }

    [Fact]
    public void FromSendOnlyHandle_ReportsGS0550()
    {
        var (diagnostics, _) = Bind("""
            package P
            func f(w out chan[int32]) {
                let (v, ok) = <-w
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0550", diagnostic.Id);
    }

    [Fact]
    public void FromNonChannel_ReportsGS0139()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let n = 3
                let (v, ok) = <-n
            }
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0139");
    }

    [Fact]
    public void InChanParameter_Receives()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P0174TwoValueIn
            {{Flag}}
            func take(r in chan[int32]) int32 {
                let (v, ok) = <-r
                return v * 10 + flag(ok)
            }
            let ch = chan[int32](1)
            ch <- 3
            take(ch)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(31, result.Value);
    }

    [Fact]
    public void NullableElement_NilWithOkTrue_IsDistinguishableFromClosed()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P0174TwoValueNil
            {{Flag}}
            let ch = chan[string?](2)
            ch <- nil
            ch.Close()
            let (first, okFirst) = <-ch
            let (second, okSecond) = <-ch
            flag(first == nil) * 1000 + flag(okFirst) * 100 + flag(second == nil) * 10 + flag(okSecond)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1110, result.Value);
    }

    [Fact]
    public void ForeignBclChannel_TakesTheFallback()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P0174TwoValueForeign
            import System.Threading.Channels
            {{Flag}}
            let foreign = Channel.CreateBounded[int32](2)
            foreign <- 4
            let (v, ok) = <-foreign
            foreign.Close()
            let (z, ok2) = <-foreign
            flag(ok) * 100 + v * 10 + flag(ok2) * 1000 + z
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(140, result.Value);
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, Compilation Compilation) Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return (EmittedOracle.CompileDiagnostics(compilation), compilation);
    }
}
