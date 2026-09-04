// <copyright file="Issue3303GenericMapFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3303 (ADR-0158 spike fallout, part of #3163): a generic class with
/// a <c>map[K, V]</c> field over its own type parameters. Two sub-bugs:
///
/// <para>1. The field-shape NRE (the literal assigned in <c>init()</c>
/// "never reaching" the field) was the #3301/#3306 family — the map
/// index-read/assign/len/delete emit paths reflected over the null
/// <c>MapTypeSymbol.ClrType</c> (null by construction when K or V is a type
/// parameter). #3306's symbolic <c>Dictionary`2</c> MemberRef routing fixed
/// the whole generic-field matrix; the tests here pin that matrix from the
/// issue's own repro shapes (they are regression pins, green since #3306).</para>
///
/// <para>2. <c>m != nil</c> / <c>m == nil</c> on ANY map-typed operand
/// (generic or monomorphic) failed to bind with GS0129 even though a map is
/// unconditionally a reference-backed <c>Dictionary&lt;K, V&gt;</c> and a
/// declared-but-unassigned map field genuinely IS nil at runtime. The fix
/// adds <c>MapTypeSymbol</c> to the #796 reference-shaped nil-compare family
/// (comparison-only — bare-slot nil ASSIGNMENT still requires the explicit
/// <c>map[K, V]?</c> spelling per ADR-0104, mirroring function types). These
/// witnesses were red before the fix. Related sweep fixes witnessed here:
/// open-map → <c>object</c> conversion (GS0155) and open-map arguments in
/// CLR overload resolution (GS0159 on <c>Console.WriteLine(items)</c>).</para>
/// </summary>
public class Issue3303GenericMapFieldEmitTests
{
    private const string GenericMapClass = """
        class G[K, V any] {
            var items map[K, V]
            init() { items = map[K, V]{} }
            func S(k K, v V) { items[k] = v }
            func L(k K) V { return items[k] }
            func Len() int32 { return items.Count }
            func Del(k K) { items.Remove(k) }
        }
        """;

    // ---------------------------------------------------------------
    // Sub-bug 1: generic map field matrix (regression pins for #3306's
    // fix, expressed as the #3303 repro shapes).
    // ---------------------------------------------------------------

    [Fact]
    public void GenericClassMapField_IssueRepro_StoreAndLoadRoundTrip()
    {
        // The exact issue #3303 repro: literal construction in init(),
        // store/load through the field at [string, int32].
        var result = EmittedOracle.Evaluate($$"""
            package P3303Repro


            {{GenericMapClass}}

            func run() int32 {
                var g = G[string, int32]()
                g.S("a", 42)
                return g.L("a")
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericClassMapField_LenAndDelete_ThroughField()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3303LenDelete


            {{GenericMapClass}}

            func run() int32 {
                var g = G[string, int32]()
                g.S("a", 1)
                g.S("b", 2)
                let before = g.Len()
                g.Del("a")
                return before * 10 + g.Len()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(21, result.Value);
    }

    [Fact]
    public void GenericClassMapField_UserStructValueArgument_RoundTrips()
    {
        // V substituted with a same-compilation user struct — the shape
        // whose ClrType is null even monomorphically (#3301 family).
        var result = EmittedOracle.Evaluate($$"""
            package P3303StructValue


            struct Pt { var X int32 }

            {{GenericMapClass}}

            func run() int32 {
                var h = G[int32, Pt]()
                h.S(1, Pt{X: 7})
                return h.L(1).X
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void GenericClassMapField_UserStructKeyArgument_RoundTrips()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3303StructKey


            struct Pt { var X int32 }

            {{GenericMapClass}}

            func run() string {
                var p = G[Pt, string]()
                p.S(Pt{X: 3}, "three")
                return p.L(Pt{X: 3})
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal("three", result.Value);
    }

    [Fact]
    public void GenericStructMapField_RoundTrips()
    {
        // Value-type generic container (struct, not class) with the same
        // map[K, V] field shape.
        var result = EmittedOracle.Evaluate("""
            package P3303GenericStruct

            struct SG[K, V any] {
                var items map[K, V]
                init() { items = map[K, V]{} }
                func S(k K, v V) { items[k] = v }
                func L(k K) V { return items[k] }
            }

            func run() int32 {
                var g = SG[string, int32]()
                g.S("a", 42)
                return g.L("a")
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericClassMapField_NestedGenericValueArgument_RoundTrips()
    {
        // V substituted with another instantiation of the same generic
        // class — map[string, G[string, int32]] through the field.
        var result = EmittedOracle.Evaluate($$"""
            package P3303Nested


            {{GenericMapClass}}

            func run() int32 {
                var g = G[string, int32]()
                g.S("a", 42)
                var u = G[string, G[string, int32]]()
                u.S("inner", g)
                return u.L("inner").L("a")
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericMethodLocalMap_OverMethodTypeParameters_RoundTrips()
    {
        // MVAR flavor: a map[K, V] local inside a generic top-level func.
        var result = EmittedOracle.Evaluate("""
            package P3303MethodLocal

            func pick[K, V any](k K, v V) V {
                var m = map[K, V]{}
                m[k] = v
                return m[k]
            }

            pick("z", 9)
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void NonGenericMapField_RegressionPin_RoundTrips()
    {
        // The monomorphic control from the issue — must stay green.
        var result = EmittedOracle.Evaluate("""
            package P3303Mono

            class M {
                var items map[string, int32]
                init() { items = map[string, int32]{} }
                func S(k string, v int32) { items[k] = v }
                func L(k string) int32 { return items[k] }
            }

            func run() int32 {
                var m = M()
                m.S("a", 42)
                return m.L("a")
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    // ---------------------------------------------------------------
    // Sub-bug 2: nil comparison on map-typed operands (red pre-fix).
    // ---------------------------------------------------------------

    [Fact]
    public void GenericMapField_NotNilComparison_BindsAndIsTrueAfterInit()
    {
        // The issue's probe: `items != nil` inside the generic class
        // reported GS0129 pre-fix.
        var result = EmittedOracle.Evaluate("""
            package P3303NilProbe

            class G[K, V any] {
                var items map[K, V]
                init() { items = map[K, V]{} }
                func Ready() bool { return items != nil }
            }

            func run() bool {
                var g = G[string, int32]()
                return g.Ready()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0129");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void GenericMapField_UnassignedField_IsEmptyNotNil()
    {
        // Issue #3310 / ADR-0159 flipped this pin's observation: a
        // declared-but-uninitialized map field no longer holds a CLR null —
        // it holds the SOUND EMPTY-INSTANCE zero value (synthesized field
        // initializer, symbolic Dictionary`2 ctor for open K/V), so the
        // bare non-`?` spelling's non-null promise is true. The comparison
        // still binds; it now observes non-nil at every point.
        var result = EmittedOracle.Evaluate("""
            package P3303UnassignedNil


            class H[K, V any] {
                var items map[K, V]
                init() { }
                func IsNil() bool { return items == nil }
                func Count() int32 { return items.Count }
            }

            func run() int32 {
                var h = H[string, int32]()
                if h.IsNil() {
                    return -1
                }

                return h.Count()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Theory]
    [InlineData("m != nil", true)]
    [InlineData("m == nil", false)]
    [InlineData("nil != m", true)]
    [InlineData("nil == m", false)]
    public void MonomorphicMap_NilComparison_BothOperatorsBothOrders(string comparison, bool expected)
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3303MonoNil

            var m = map[string, int32]{"a": 1}
            {{comparison}}
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0129");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void MapNilComparison_InValueContext_FlowsAsBool()
    {
        // Value (non-branch) context: the comparison result stored and
        // combined as an ordinary bool.
        var result = EmittedOracle.Evaluate("""
            package P3303NilValueCtx

            var m = map[string, int32]{}
            var probe = m != nil
            var count = 0
            if probe {
                count = count + 1
            }

            if m == nil {
                count = count + 10
            }

            count
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void NullableMap_NarrowedBySmartCast_NilComparisonStillBinds()
    {
        // ADR-0104's `map[K, V]?` spelling already bound nil-compare via the
        // NullableTypeSymbol arm — but after an assignment the smart-cast
        // narrows the slot to the BARE map type, which then failed GS0129
        // pre-fix. Pins the narrowing interplay.
        var result = EmittedOracle.Evaluate("""
            package P3303NarrowedNil

            var n map[string, int32]? = nil
            var first = n == nil
            n = map[string, int32]{"a": 1}
            var second = n != nil
            first && second
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0129");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NullableMap_ExplicitSpelling_RegressionPin()
    {
        // The pre-existing `map[K, V]?` nullable arm — green before and
        // after this fix.
        var result = EmittedOracle.Evaluate("""
            package P3303NullableMapPin

            class G[K, V any] {
                var items map[K, V]?
                init() { items = nil }
                func IsNil() bool { return items == nil }
                func Fill() { items = map[K, V]{} }
            }

            func run() bool {
                var g = G[string, int32]()
                var before = g.IsNil()
                g.Fill()
                return before && !g.IsNil()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SliceNilComparison_ParityPin_NowBinds()
    {
        // Issue #3310 / ADR-0159: the deliberate slice rejection this pin
        // used to guard was flipped — nil comparison now binds for every
        // reference-backed magic type. A live slice value is not nil.
        var result = EmittedOracle.Evaluate("""
            package P3303SlicePin

            var s = []int32{1}
            s != nil
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ChannelNilComparison_ParityPin_NowBinds()
    {
        // Issue #3310 / ADR-0159: same flip as the slice pin above.
        var result = EmittedOracle.Evaluate("""
            package P3303ChanPin


            var c = chan[int32](1)
            c != nil
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void BareMapNilAssignment_StillRequiresNullableSpelling()
    {
        // Comparison-only semantics: assigning nil INTO a bare map slot
        // still requires the explicit `map[K, V]?` spelling (ADR-0104),
        // exactly like bare function-typed slots (#715/#796).
        var result = EmittedOracle.Evaluate("""
            package P3303NoBareNilAssign

            var m = map[string, int32]{}
            m = nil
            m == nil
            """);

        Assert.Contains(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    // ---------------------------------------------------------------
    // Sweep fixes: open-map → object conversion and overload resolution.
    // ---------------------------------------------------------------

    [Fact]
    public void GenericMapField_WidensToObject_InReturnPosition()
    {
        // Pre-fix: GS0155 "Cannot convert type 'map[K,V]' to 'object'" —
        // the classify object-widening rule required a non-null ClrType.
        var result = EmittedOracle.Evaluate("""
            package P3303ObjectWiden

            class G[K, V any] {
                var items map[K, V]
                init() { items = map[K, V]{} }
                func AsObj() object { return items }
            }

            func run() bool {
                var g = G[string, int32]()
                return g.AsObj() != nil
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0155");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void GenericMapField_AsClrCallArgument_ResolvesObjectOverload()
    {
        // Pre-fix: GS0159 "Cannot find function WriteLine" — the open map
        // produced no effective CLR type for overload resolution, so the
        // candidate set was abandoned before ranking `WriteLine(object)`.
        var result = EmittedOracle.Evaluate("""
            package P3303WriteLine

            class G[K, V any] {
                var items map[K, V]
                init() { items = map[K, V]{} }
                func Show() { Console.WriteLine(items) }
            }

            var g = G[string, int32]()
            g.Show()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Contains("Dictionary", result.Output);
    }
}
