// <copyright file="Issue3317NilCompareAlwaysConstantWarningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3317 / ADR-0159: GS0523, the statically-constant nil-comparison
/// warning. With sound empty-instance zero values a bare (non-<c>?</c>)
/// <c>map[K, V]</c> / <c>[]T</c> / <c>[N]T</c> / <c>chan[T]</c> value can
/// never be nil, so <c>== nil</c> is always false and <c>!= nil</c> always
/// true — typically dead code ported verbatim from Go. The warning is
/// static-type based (v1): it fires for both operand orders, and does NOT
/// fire for <c>?</c>-typed slots (interop values surfaced as <c>T?</c>
/// included), for smart-cast-narrowed reads of <c>?</c>-declared slots, or
/// for <c>sequence[T]</c> (excluded from v1 — #796-era interop pattern).
/// </summary>
public class Issue3317NilCompareAlwaysConstantWarningTests
{
    [Theory]
    [InlineData("m == nil", "always false", false)]
    [InlineData("m != nil", "always true", true)]
    [InlineData("nil == m", "always false", false)]
    [InlineData("nil != m", "always true", true)]
    public void BareMap_NilComparison_Warns_BothOperators_BothOrders(string probe, string expectedPhrase, bool expectedValue)
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3317MapWarn

            var m = map[string, int32]{}
            {{probe}}
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0523" && d.Severity == DiagnosticSeverity.Warning && d.Message.Contains(expectedPhrase));
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);

        // The comparison still binds and evaluates — GS0523 is advisory.
        Assert.Equal(expectedValue, result.Value);
    }

    [Theory]
    [InlineData("s == nil", "always false")]
    [InlineData("s != nil", "always true")]
    [InlineData("nil == s", "always false")]
    [InlineData("nil != s", "always true")]
    public void BareSlice_NilComparison_Warns_BothOperators_BothOrders(string probe, string expectedPhrase)
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3317SliceWarn

            var s = []int32{1}
            {{probe}}
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0523" && d.Severity == DiagnosticSeverity.Warning && d.Message.Contains(expectedPhrase));
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void BareChannel_NilComparison_Warns()
    {
        // GS0520 forces bare channel slots to be explicitly initialized, so
        // a bare `chan[T]` operand is likewise never nil. (ADR-0174: the slot
        // is declared with the type clause — an inferred `let c = chan[int32](1)`
        // has the runtime's `Chan[int32]` class type, an ordinary reference.)
        var result = EmittedOracle.Evaluate("""
            package P3317ChanWarn

            var c chan[int32] = chan[int32](1)
            c == nil
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0523" && d.Severity == DiagnosticSeverity.Warning && d.Message.Contains("always false"));
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void BareFixedArray_NilComparison_Warns()
    {
        var result = EmittedOracle.Evaluate("""
            package P3317ArrWarn

            var a = [2]int32{7, 8}
            a != nil
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0523" && d.Severity == DiagnosticSeverity.Warning && d.Message.Contains("always true"));
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void NullableMapSlot_DoesNotWarn()
    {
        var result = EmittedOracle.Evaluate("""
            package P3317MapOptOk

            var m map[string, int32]? = nil
            m == nil
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0523");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NullableChannelSlot_DoesNotWarn()
    {
        // The #3315 spelling: `chan[T]?` is the genuinely-optional channel;
        // its nil check is exactly what the comparison exists for.
        var result = EmittedOracle.Evaluate("""
            package P3317ChanOptOk


            var c chan[int32]?
            c == nil
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0523");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SmartCastNarrowedRead_DoesNotWarn()
    {
        // v1 is declared-static-type based: inside the `m != nil` guard the
        // read of `m` is a narrowed view of a `?`-declared slot, so the
        // (redundant) re-check does not warn — recorded as a possible future
        // "redundant check" refinement instead.
        var result = EmittedOracle.Evaluate("""
            package P3317NarrowedOk

            func Check(m map[string, int32]?) bool {
                if m != nil {
                    return m == nil
                }
                return false
            }

            Check(map[string, int32]{})
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0523");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void BareSequence_DoesNotWarn()
    {
        // Excluded from v1: sequence nil comparison predates ADR-0159 (#796)
        // and bare sequence values commonly cross interop boundaries.
        var result = EmittedOracle.Evaluate("""
            package P3317SeqOk

            func IsNil(xs sequence[int32]) bool {
                return xs == nil
            }

            IsNil([]int32{1})
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0523");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void BareMapParameter_Warns()
    {
        // The issue's motivating shape: a Go-ported guard on a bare map
        // parameter is dead code.
        var result = EmittedOracle.Evaluate("""
            package P3317ParamWarn

            func Lookup(m map[string, int32], key string) int32 {
                if m == nil {
                    return -1
                }
                return m[key]
            }

            Lookup(map[string, int32]{"a": 1}, "a")
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0523" && d.Severity == DiagnosticSeverity.Warning);
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(1, result.Value);
    }
}
