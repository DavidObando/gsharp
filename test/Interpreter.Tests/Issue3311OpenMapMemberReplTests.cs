// <copyright file="Issue3311OpenMapMemberReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3311: CLR-interop member access on open-generic <c>map[K, V]</c>
/// receivers (<c>ContainsKey</c> / <c>TryGetValue</c> / <c>Keys</c> /
/// <c>Count</c>) through the session engine, in both same-cell and
/// cross-cell form. The same-cell arms compile while the generic container's
/// TypeDef is still being emitted; the cross-cell arms pin parity once the
/// prior cell's class carries a real loaded ClrType.
/// </summary>
public sealed class Issue3311OpenMapMemberReplTests
{
    private const string GenericMapMemberClassCell = """
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
            func SumKeys() int32 {
                var n = 0
                for k in items.Keys {
                    n = n + 1
                }
                return n
            }
        }
        """;

    [Fact]
    public void SameCell_GenericMapMember_ContainsKey_And_TryGetValue()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(GenericMapMemberClassCell + """


            var g = G[string, int32]()
            g.S("a", 41)
            var x = g.Find("a", 0)
            var missing = g.Find("b", 1)
            g.Has("a") && !g.Has("b") && x + missing == 42
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SameCell_GenericMapMember_Count_And_Keys()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(GenericMapMemberClassCell + """


            var g = G[string, string]()
            g.S("a", "x")
            g.S("b", "y")
            g.N() * 10 + g.SumKeys()
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(22, result.Value);
    }

    [Fact]
    public void SameCell_GenericFunc_ContainsKey_On_OpenMapParameter()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            func Has[K any, V any](items map[K, V], k K) bool {
                return items.ContainsKey(k)
            }

            var m = map[string, int32]{"a": 1}
            Has[string, int32](m, "a") && !Has[string, int32](m, "b")
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void CrossCell_GenericMapMember_FullSurface()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, GenericMapMemberClassCell);
        AssertOk(engine, "var g = G[string, int32]()");
        AssertOk(engine, "g.S(\"a\", 40)");

        var has = engine.Evaluate("g.Has(\"a\")");
        Assert.False(has.HasError, string.Join("; ", has.Diagnostics));
        Assert.Equal(true, has.Value);

        var probe = engine.Evaluate("g.Find(\"a\", 0) + g.N() + g.SumKeys()");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(42, probe.Value);
    }

    [Fact]
    public void CrossCell_GenericFunc_MemberSurface_OnLaterCellMap()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            func Size[K any, V any](items map[K, V]) int32 {
                return items.Count
            }
            """);
        AssertOk(engine, "var m = map[string, int32]{\"a\": 1, \"b\": 2}");

        var probe = engine.Evaluate("Size[string, int32](m)");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(2, probe.Value);
    }

    [Fact]
    public void SameCell_ConcreteMap_MemberAccess_Pin()
    {
        // Monomorphic control: loadable-ClrType member access through the
        // session engine keeps working.
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            var m = map[string, int32]{"a": 40, "b": 2}
            var ok = m.TryGetValue("b", out var v)
            m.ContainsKey("a") && ok && m.Count + v == 4
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(true, result.Value);
    }

    private static void AssertOk(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
    }
}
