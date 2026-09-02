// <copyright file="Issue3310MagicTypeNilCompareEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3310 / ADR-0159, nil-comparison half: <c>x == nil</c> /
/// <c>x != nil</c> binds for EVERY reference-backed magic type. #3309 added
/// maps; this adds slices (<c>[]T</c>), fixed arrays (<c>[N]T</c>), and
/// channels (<c>chan[T]</c>), flipping #3309's deliberate-rejection pins.
/// Matrix per kind: both operators, both operand orders (#3217 nil-on-left
/// canonicalization), plus the open-generic (null-ClrType) field shape.
/// Comparison-only semantics are pinned: bare-slot nil ASSIGNMENT still
/// requires the (not-yet-expressible-for-these-kinds) <c>?</c> spelling per
/// ADR-0104, so <c>s = nil</c> / <c>c = nil</c> stay errors.
/// </summary>
public class Issue3310MagicTypeNilCompareEmitTests
{
    [Theory]
    [InlineData("s != nil", true)]
    [InlineData("s == nil", false)]
    [InlineData("nil != s", true)]
    [InlineData("nil == s", false)]
    public void SliceNilComparison_BothOperators_BothOrders(string probe, bool expected)
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3310SliceNil

            var s = []int32{1}
            {{probe}}
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(expected, result.Value);
    }

    [Theory]
    [InlineData("c != nil", true)]
    [InlineData("c == nil", false)]
    [InlineData("nil != c", true)]
    [InlineData("nil == c", false)]
    public void ChannelNilComparison_BothOperators_BothOrders(string probe, bool expected)
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3310ChanNil


            var c = chan[int32](1)
            {{probe}}
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(expected, result.Value);
    }

    [Theory]
    [InlineData("a != nil", true)]
    [InlineData("a == nil", false)]
    public void FixedArrayNilComparison_BothOperators(string probe, bool expected)
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3310ArrNil

            var a = [2]int32{7, 8}
            {{probe}}
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void OpenGenericSliceField_NilComparison_Binds()
    {
        // The null-ClrType shape: a `[]K` field of a generic class. The
        // comparison must bind symbolically, exactly like the #3303 map arm.
        var result = EmittedOracle.Evaluate("""
            package P3310OpenSliceNil

            class G[K any] {
                var xs []K
                init() { xs = []K{} }
                func Ready() bool { return xs != nil }
            }

            func run() bool {
                var g = G[string]()
                return g.Ready()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void BareSliceNilAssignment_StillRejected()
    {
        // Comparison-only (ADR-0104 discipline unchanged): nil cannot be
        // ASSIGNED into a bare slice slot.
        var result = EmittedOracle.Evaluate("""
            package P3310NoSliceNilAssign

            var s = []int32{1}
            s = nil
            s == nil
            """);

        Assert.Contains(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    [Fact]
    public void BareChannelNilAssignment_StillRejected()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310NoChanNilAssign


            var c = chan[int32](1)
            c = nil
            c == nil
            """);

        Assert.Contains(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }
}
