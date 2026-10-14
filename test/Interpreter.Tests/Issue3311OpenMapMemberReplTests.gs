// <copyright file="Issue3311OpenMapMemberReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import Xunit

/// Issue #3311: CLR-interop member access on open-generic `map[K, V]`
/// receivers (`ContainsKey` / `TryGetValue` / `Keys` /
/// `Count`) through the session engine, in both same-cell and
/// cross-cell form. The same-cell arms compile while the generic container's
/// TypeDef is still being emitted; the cross-cell arms pin parity once the
/// prior cell's class carries a real loaded ClrType.
class Issue3311OpenMapMemberReplTests {
    @Fact
    func SameCell_GenericMapMember_ContainsKey_And_TryGetValue() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(GenericMapMemberClassCell + `

var g = G[string, int32]()
g.S("a", 41)
var x = g.Find("a", 0)
var missing = g.Find("b", 1)
g.Has("a") && !g.Has("b") && x + missing == 42`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    @Fact
    func SameCell_GenericMapMember_Count_And_Keys() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(GenericMapMemberClassCell + `

var g = G[string, string]()
g.S("a", "x")
g.S("b", "y")
g.N() * 10 + g.SumKeys()`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(22, result.Value)
    }

    @Fact
    func SameCell_GenericFunc_ContainsKey_On_OpenMapParameter() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(`func Has[K any, V any](items map[K, V], k K) bool {
    return items.ContainsKey(k)
}

var m = map[string, int32]{"a": 1}
Has[string, int32](m, "a") && !Has[string, int32](m, "b")`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    @Fact
    func CrossCell_GenericMapMember_FullSurface() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, GenericMapMemberClassCell)
        AssertOk(engine, "var g = G[string, int32]()")
        AssertOk(engine, "g.S(\"a\", 40)")
        let has = engine.Evaluate("g.Has(\"a\")")
        Assert.False(has.HasError, string.Join("; ", has.Diagnostics))
        Assert.Equal(true, has.Value)
        let probe = engine.Evaluate("g.Find(\"a\", 0) + g.N() + g.SumKeys()")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(42, probe.Value)
    }

    @Fact
    func CrossCell_GenericFunc_MemberSurface_OnLaterCellMap() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `func Size[K any, V any](items map[K, V]) int32 {
    return items.Count
}`)
        AssertOk(engine, "var m = map[string, int32]{\"a\": 1, \"b\": 2}")
        let probe = engine.Evaluate("Size[string, int32](m)")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(2, probe.Value)
    }

    @Fact
    func SameCell_ConcreteMap_MemberAccess_Pin() {
        // Monomorphic control: loadable-ClrType member access through the
        // session engine keeps working.
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(`var m = map[string, int32]{"a": 40, "b": 2}
var ok = m.TryGetValue("b", out var v)
m.ContainsKey("a") && ok && m.Count + v == 4`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(true, result.Value)
    }

    shared {
        private const GenericMapMemberClassCell string = `class G[K, V any] {
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
}`

        private func AssertOk(engine EmittedSessionEngine, cell string) {
            let result = engine.Evaluate(cell)
            Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        }
    }
}
