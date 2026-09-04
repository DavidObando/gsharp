// <copyright file="Issue3311OpenMapMemberLookupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3311 (residual from #3303 / PR #3309, part of #3163): CLR-interop
/// member access on an OPEN-generic <c>map[K, V]</c> receiver —
/// <c>items.ContainsKey(k)</c>, <c>items.Keys</c>, <c>items.Count</c>,
/// <c>items.GetEnumerator()</c> — inside a generic function or generic type
/// reported GS0159 (member not found) because member lookup reflected over
/// <c>MapTypeSymbol.ClrType</c>, which is null by construction when K or V is
/// a type parameter.
///
/// <para>The fix normalizes an open map receiver to the same symbolic
/// constructed <c>Dictionary[K, V]</c> view an explicitly-typed
/// <c>Dictionary[K, V]</c> receiver already carries (#313/#794/#1107): the
/// erased closed shape drives reflection lookup, the symbolic [K, V]
/// arguments drive return/parameter/out-var re-projection, and the emitter
/// parents the MemberRefs at the <c>Dictionary&lt;!K, !V&gt;</c> TypeSpec
/// (the general-member counterpart of the #1481/#3306 dedicated map
/// helpers).</para>
///
/// <para>The builtin operations (<c>m[k]</c>, <c>len</c>, <c>delete</c>,
/// <c>range</c>) already worked on open maps (#3306/#3309); regression pins
/// for those, and for CONCRETE-map member access, are included at the
/// bottom.</para>
/// </summary>
public class Issue3311OpenMapMemberLookupEmitTests
{
    // ---------------------------------------------------------------
    // Generic FUNCTION context — the issue's headline repro shapes.
    // ---------------------------------------------------------------

    [Fact]
    public void GenericFunc_ContainsKey_OnOpenMap_Binds_And_Runs()
    {
        var result = EmittedOracle.Evaluate("""
            package P3311ContainsKey

            func Has[K any, V any](items map[K, V], k K) bool {
                return items.ContainsKey(k)
            }

            func run() bool {
                var m = map[string, int32]{"a": 1}
                return Has[string, int32](m, "a") && !Has[string, int32](m, "b")
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void GenericFunc_TryGetValue_OutVar_Recovers_Symbolic_V()
    {
        // The out-var local must bind as the symbolic V (not the erased
        // object) so it can be returned at the V-typed slot.
        var result = EmittedOracle.Evaluate("""
            package P3311TryGetValue

            func Find[K any, V any](items map[K, V], k K, fb V) V {
                var ok = items.TryGetValue(k, out var v)
                if ok { return v }
                return fb
            }

            func run() int32 {
                var m = map[string, int32]{"a": 41}
                return Find[string, int32](m, "a", 0) + Find[string, int32](m, "b", 1)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericFunc_Keys_Iteration_Recovers_Symbolic_K()
    {
        // `.Keys` must surface as a keyed collection over the symbolic K so
        // the iteration variable unifies with the K-typed return.
        var result = EmittedOracle.Evaluate("""
            package P3311Keys

            func SumKeys[V any](items map[int32, V]) int32 {
                var total = 0
                for k in items.Keys {
                    total = total + k
                }
                return total
            }

            func run() int32 {
                var m = map[int32, string]{40: "a", 2: "b"}
                return SumKeys[string](m)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericFunc_Keys_FullyOpen_ReturnsFirstKey_As_K()
    {
        // Fully-open twin of the #794 `Dictionary[K, V]().Keys` shape, but
        // through the map[K, V] spelling: the iteration variable must be K.
        var result = EmittedOracle.Evaluate("""
            package P3311KeysOpen

            func FirstKey[K any, V any](items map[K, V], fb K) K {
                for k in items.Keys {
                    return k
                }
                return fb
            }

            func run() string {
                var m = map[string, int32]{"hit": 1}
                return FirstKey[string, int32](m, "miss")
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal("hit", result.Value);
    }

    [Fact]
    public void GenericFunc_Values_Iteration_Recovers_Symbolic_V()
    {
        var result = EmittedOracle.Evaluate("""
            package P3311Values

            func SumValues[K any](items map[K, int32]) int32 {
                var total = 0
                for v in items.Values {
                    total = total + v
                }
                return total
            }

            func run() int32 {
                var m = map[string, int32]{"a": 40, "b": 2}
                return SumValues[string](m)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericFunc_Count_Property_OnOpenMap()
    {
        var result = EmittedOracle.Evaluate("""
            package P3311Count

            func Size[K any, V any](items map[K, V]) int32 {
                return items.Count
            }

            func run() int32 {
                var m = map[string, int32]{"a": 1, "b": 2, "c": 3}
                return Size[string, int32](m)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void GenericFunc_GetEnumerator_ManualLoop_OnOpenMap()
    {
        // GetEnumerator() returns the symbolic Dictionary[K, V].Enumerator;
        // MoveNext/Current.Key/Current.Value must chain through it.
        var result = EmittedOracle.Evaluate("""
            package P3311Enumerator

            func Sum[K any](items map[K, int32]) int32 {
                var total = 0
                var e = items.GetEnumerator()
                while e.MoveNext() {
                    total = total + e.Current.Value
                }
                return total
            }

            func run() int32 {
                var m = map[string, int32]{"a": 40, "b": 2}
                return Sum[string](m)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    // ---------------------------------------------------------------
    // Generic TYPE context — the member surface through a map field.
    // ---------------------------------------------------------------

    private const string GenericMapMemberClass = """
        class G[K, V any] {
            var items map[K, V]
            init() { items = map[K, V]{} }
            func S(k K, v V) { items[k] = v }
            func Has(k K) bool { return items.ContainsKey(k) }
            func Find(k K, fb V) V {
                var ok = items.TryGetValue(k, out var v)
                if ok { return v }
                return fb
            }
            func N() int32 { return items.Count }
        }
        """;

    [Fact]
    public void GenericClass_ContainsKey_Through_MapField()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3311ClassHas

            {{GenericMapMemberClass}}

            func run() bool {
                var g = G[string, int32]()
                g.S("a", 1)
                return g.Has("a") && !g.Has("b")
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void GenericClass_TryGetValue_And_Count_Through_MapField()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3311ClassFind

            {{GenericMapMemberClass}}

            func run() int32 {
                var g = G[string, int32]()
                g.S("a", 40)
                return g.Find("a", 0) + g.Find("b", 1) + g.N()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    // ---------------------------------------------------------------
    // Instantiation matrix: value-type, reference-type, user-struct
    // type arguments through the generic member surface.
    // ---------------------------------------------------------------

    [Fact]
    public void GenericClass_ValueTypeInstantiation_MemberSurface()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3311ValueInst

            {{GenericMapMemberClass}}

            func run() int32 {
                var g = G[int32, int32]()
                g.S(7, 40)
                if g.Has(7) {
                    return g.Find(7, 0) + g.N() + 1
                }
                return -1
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericClass_ReferenceTypeInstantiation_MemberSurface()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3311RefInst

            {{GenericMapMemberClass}}

            func run() string {
                var g = G[string, string]()
                g.S("k", "hit")
                if g.Has("k") {
                    return g.Find("k", "miss")
                }
                return "miss"
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal("hit", result.Value);
    }

    [Fact]
    public void GenericClass_UserStructValueInstantiation_MemberSurface()
    {
        // V substituted with a same-compilation user struct — the
        // symbol-only value-type shape whose ClrType is null even
        // monomorphically (#3301/#3306 family).
        var result = EmittedOracle.Evaluate($$"""
            package P3311StructInst

            struct Pt { var X int32 }

            {{GenericMapMemberClass}}

            func run() int32 {
                var g = G[string, Pt]()
                g.S("a", Pt{X: 42})
                if g.Has("a") {
                    return g.Find("a", Pt{X: 0}).X
                }
                return -1
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericFunc_UserStructInstantiation_ContainsKey_And_Keys()
    {
        var result = EmittedOracle.Evaluate("""
            package P3311StructFunc

            struct Pt { var X int32 }

            func Has[K any, V any](items map[K, V], k K) bool {
                return items.ContainsKey(k)
            }

            func CountKeys[K any, V any](items map[K, V]) int32 {
                var n = 0
                for k in items.Keys {
                    n = n + 1
                }
                return n
            }

            func run() int32 {
                var m = map[string, Pt]{"a": Pt{X: 1}, "b": Pt{X: 2}}
                if Has[string, Pt](m, "a") {
                    return 40 + CountKeys[string, Pt](m)
                }
                return -1
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ExplicitDictionary_MixedArity_KeysIteration_Fixed()
    {
        // Companion latent bug fixed by the same change (pre-existing on
        // main, NOT map-specific): iterating `.Keys` of an explicit
        // `Dictionary[int32, V]` — a MIXED concrete/open instantiation —
        // recovered `IEnumerator[int32]` through the erased closed shape,
        // but the loop lowering fell back to the closed `object` Current
        // (HasSubstitutableTypeArgument is false for [int32]) and the
        // widening-skip guard required a symbolic type argument, injecting
        // a spurious `unbox.any int32` (ILVerify StackObjRef, runtime NRE).
        var result = EmittedOracle.Evaluate("""
            package P3311DictMixed

            import System.Collections.Generic

            func SumKeys[V any](d Dictionary[int32, V]) int32 {
                var total = 0
                for k in d.Keys {
                    total = total + k
                }
                return total
            }

            func run() int32 {
                var m = Dictionary[int32, string]()
                m[40] = "a"
                m[2] = "b"
                return SumKeys[string](m)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    // ---------------------------------------------------------------
    // Regression pins.
    // ---------------------------------------------------------------

    [Fact]
    public void Pin_ConcreteMap_MemberAccess_Unchanged()
    {
        // Monomorphic control: the loadable-ClrType reflection fast path
        // must keep working exactly as before.
        var result = EmittedOracle.Evaluate("""
            package P3311ConcretePin


            func run() int32 {
                var m = map[string, int32]{"a": 40, "b": 2}
                var total = 0
                var ok = m.TryGetValue("b", out var v)
                if m.ContainsKey("a") && ok {
                    total = total + v + m.Count
                }
                for k in m.Keys {
                    total = total + 1
                }
                return total * 6
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(36, result.Value);
    }

    [Fact]
    public void Pin_OpenMap_BuiltinOps_Unchanged()
    {
        // The #3306/#3309 arms: index read/assign, len, delete on an open
        // map must keep working alongside the new member surface. (Map
        // `for ... in` iteration is a separate pre-existing GS0116 gap for
        // ALL maps — documented in #3309 — so it is not exercised here.)
        var result = EmittedOracle.Evaluate("""
            package P3311BuiltinPin


            func Mix[K any](items map[K, int32], k K) int32 {
                items[k] = 40
                var total = items[k] + items.Count
                items.Remove(k)
                return total + items.Count + 1
            }

            func run() int32 {
                var m = map[string, int32]{}
                return Mix[string](m, "a")
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Pin_OpenMap_OverloadArgument_Unchanged()
    {
        // The #3309 overload-argument arm: an open map passed to a CLR
        // overload set (object-shaped parameter) must keep resolving.
        var result = EmittedOracle.Evaluate("""
            package P3311OverloadPin

            import System

            func Show[K any, V any](items map[K, V]) {
                Console.WriteLine(items)
            }

            func run() int32 {
                var m = map[string, int32]{"a": 1}
                Show[string, int32](m)
                return 42
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(42, result.Value);
    }
}
