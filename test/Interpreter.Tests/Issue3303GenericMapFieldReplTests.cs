// <copyright file="Issue3303GenericMapFieldReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3303 (ADR-0158 spike fallout): generic <c>map[K, V]</c> fields and
/// map nil-comparison through the session engine, in both same-cell and
/// cross-cell form. The same-cell arms exercise the null-ClrType shapes (the
/// class TypeDef does not exist yet while the cell compiles); the cross-cell
/// arms are the parity pins — a prior-cell class has a real loaded ClrType,
/// which is why the #3301-family bugs historically only died same-cell.
/// </summary>
public sealed class Issue3303GenericMapFieldReplTests
{
    private const string GenericMapClassCell = """
        class G[K, V any] {
            var items map[K, V]
            init() { items = map[K, V]{} }
            func S(k K, v V) { items[k] = v }
            func L(k K) V { return items[k] }
            func Ready() bool { return items != nil }
        }
        """;

    [Fact]
    public void SameCell_GenericMapField_StoreLoadRoundTrips()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(GenericMapClassCell + """


            var g = G[string, int32]()
            g.S("a", 42)
            g.L("a")
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void CrossCell_GenericMapField_StoreLoadRoundTrips()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, GenericMapClassCell);
        AssertOk(engine, "var g = G[string, int32]()");
        AssertOk(engine, "g.S(\"a\", 42)");

        var probe = engine.Evaluate("g.L(\"a\")");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(42, probe.Value);
    }

    [Fact]
    public void SameCell_GenericMapField_NilCompareBinds()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(GenericMapClassCell + """


            var g = G[string, int32]()
            g.Ready()
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void CrossCell_GenericMapField_NilCompareBinds()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, GenericMapClassCell);
        AssertOk(engine, "var g = G[string, int32]()");

        var probe = engine.Evaluate("g.Ready()");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(true, probe.Value);
    }

    [Fact]
    public void SameCell_MonomorphicMap_NilCompare_BothOperators()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            var m = map[string, int32]{"a": 1}
            var notNil = m != nil
            var isNil = m == nil
            notNil && !isNil
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void CrossCell_MonomorphicMap_NilCompare_OnPriorCellGlobal()
    {
        // The prior-cell map global has a real loaded ClrType — the
        // comparison must bind identically in that state.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "var m = map[string, int32]{\"a\": 1}");

        var probe = engine.Evaluate("m != nil");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(true, probe.Value);
    }

    [Fact]
    public void SameCell_UnassignedGenericMapField_ObservedAsEmptyNotNil()
    {
        // Issue #3310 / ADR-0159 flipped this pin's observation: the
        // uninitialized field now holds the sound empty-instance zero value
        // (synthesized field initializer), so it is NOT nil.
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            class H[K, V any] {
                var items map[K, V]
                init() { }
                func IsNil() bool { return items == nil }
            }

            var h = H[string, int32]()
            h.IsNil()
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(false, result.Value);
    }

    private static void AssertOk(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, $"cell '{cell}': {string.Join("; ", result.Diagnostics)}");
    }
}
