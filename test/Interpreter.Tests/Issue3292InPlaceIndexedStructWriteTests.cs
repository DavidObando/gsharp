// <copyright file="Issue3292InPlaceIndexedStructWriteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3292 (follow-up to #3252, part of #3163): in-place
/// (<c>ldelema</c>-rooted) struct member writes through indexed array/slice
/// elements. Complements the shape matrix in
/// <see cref="Issue3252IndexedStructMemberWriteTests"/> with the properties
/// that make the lift SAFE: once-only evaluation of side-effecting index
/// (and collection) expressions on every write shape — the compound form
/// re-emits the element address chain on its read and write sides, so the
/// side-effecting parts must be hoisted exactly once by the
/// <c>SideEffectSpiller</c> — plus the <c>let</c>-binding heap-mutation
/// rule, property-setter writes through elements, and the map guards.
/// </summary>
public sealed class Issue3292InPlaceIndexedStructWriteTests
{
    private const string StructTemporaryMessageFragment = "not writable storage";

    private const string CounterDecls =
        "struct P { var X int }\n"
        + "var calls = 0\n"
        + "func idx() int {\n"
        + "    calls = calls + 1\n"
        + "    return 0\n"
        + "}\n"
        + "var ps = [2]P{}";

    /// <summary>
    /// Same-cell once-only: a side-effecting index expression in a SIMPLE
    /// element member write is evaluated exactly once, and the write lands
    /// in the element it selected.
    /// </summary>
    [Fact]
    public void SameCellSimpleWriteEvaluatesSideEffectingIndexOnce()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(CounterDecls + "\nps[idx()].X = 11\ncalls * 100 + ps[0].X");
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(111, result.Value);
    }

    /// <summary>
    /// Same-cell once-only: a side-effecting index expression in a COMPOUND
    /// element member write (`ps[idx()].X += v` — the shape whose read and
    /// write sides share the element receiver) is evaluated exactly once.
    /// </summary>
    [Fact]
    public void SameCellCompoundWriteEvaluatesSideEffectingIndexOnce()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(CounterDecls + "\nps[idx()].X += 5\ncalls * 100 + ps[0].X");
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(105, result.Value);
    }

    /// <summary>
    /// Same-cell once-only: increment flavor (`ps[idx()].X++`).
    /// </summary>
    [Fact]
    public void SameCellIncrementEvaluatesSideEffectingIndexOnce()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(CounterDecls + "\nps[idx()].X++\ncalls * 100 + ps[0].X");
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(101, result.Value);
    }

    /// <summary>
    /// Same-cell once-only through a NESTED chain
    /// (`ns[idx()].B2.C += v`): the field walk over the element address
    /// re-emits the chain per side, so the index must still fire once.
    /// </summary>
    [Fact]
    public void SameCellNestedCompoundWriteEvaluatesSideEffectingIndexOnce()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(
            "struct B { var C int }\n"
            + "struct A2 { var B2 B }\n"
            + "var calls = 0\n"
            + "func idx() int {\n"
            + "    calls = calls + 1\n"
            + "    return 0\n"
            + "}\n"
            + "var ns = [2]A2{}\n"
            + "ns[idx()].B2.C += 8\n"
            + "calls * 100 + ns[0].B2.C");
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(108, result.Value);
    }

    /// <summary>
    /// Same-cell once-only: a mutating method call through a side-effecting
    /// index (`ps[idx()].Bump()`) evaluates the index exactly once and
    /// mutates the selected element in place.
    /// </summary>
    [Fact]
    public void SameCellMutatingMethodEvaluatesSideEffectingIndexOnce()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(
            "struct P { var X int\n func Bump() { this.X = this.X + 1 } }\n"
            + "var calls = 0\n"
            + "func idx() int {\n"
            + "    calls = calls + 1\n"
            + "    return 0\n"
            + "}\n"
            + "var ps = [2]P{}\n"
            + "ps[idx()].Bump()\n"
            + "calls * 100 + ps[0].X");
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(101, result.Value);
    }

    /// <summary>
    /// Cross-cell once-only: compound element member write through a
    /// prior-cell global with a side-effecting index — the ADR-0156 seam
    /// path (CLR member-write chain) must hoist the index exactly once too.
    /// </summary>
    [Fact]
    public void CrossCellCompoundWriteEvaluatesSideEffectingIndexOnce()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, CounterDecls);
        AssertOk(engine, "ps[idx()].X += 5");

        var probe = engine.Evaluate("calls * 100 + ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(105, probe.Value);
    }

    /// <summary>
    /// Cross-cell once-only: simple element member write.
    /// </summary>
    [Fact]
    public void CrossCellSimpleWriteEvaluatesSideEffectingIndexOnce()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, CounterDecls);
        AssertOk(engine, "ps[idx()].X = 11");

        var probe = engine.Evaluate("calls * 100 + ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(111, probe.Value);
    }

    /// <summary>
    /// Issue #1132 shallow-immutability parity: `let` binds the VARIABLE,
    /// not the heap array it references — `ls[0] = v` is legal on a `let`
    /// array today, so the element member write (same storage, same heap
    /// mutation) is legal too and lands in place.
    /// </summary>
    [Fact]
    public void LetArrayElementMemberWriteMutatesHeapArrayInPlace()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("struct P { var X int }\nlet ls = [2]P{}\nls[0].X = 5\nls[0].X");
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(5, result.Value);
    }

    /// <summary>
    /// Property-setter writes through an array element previously mutated a
    /// spilled COPY silently (the receiver was hoisted to a temp before the
    /// setter call). With the element-address receiver path the setter runs
    /// against the stored element — matching C#'s `arr[i].Prop = v`.
    /// </summary>
    [Fact]
    public void SameCellPropertySetterThroughElementMutatesInPlace()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(
            "struct P {\n"
            + "    var x int\n"
            + "    prop X int {\n"
            + "        get { return x }\n"
            + "        set { x = value }\n"
            + "    }\n"
            + "}\n"
            + "var ps = [2]P{}\n"
            + "ps[0].X = 7\n"
            + "ps[0].x");
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(7, result.Value);
    }

    /// <summary>
    /// Map guard: the side-effecting-index shapes over a MAP stay rejected
    /// (GS0499) — the lift is strictly array-backed.
    /// </summary>
    [Theory]
    [InlineData("struct P { var X int }\nvar m = map[int, P]{1: P{}}\nm[1].X += 5")]
    [InlineData("struct P { var X int }\nvar m = map[int, P]{1: P{}}\nm[1].X++")]
    public void SameCellMapCompoundShapesStayRejected(string cell)
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(cell);
        Assert.True(result.HasError, $"cell '{cell}' bound without error — the write would silently drop");
        Assert.Contains(
            result.Diagnostics,
            d => d.ToString().Contains(StructTemporaryMessageFragment, System.StringComparison.Ordinal));
    }

    /// <summary>
    /// Cross-cell map guard: compound and increment map arms stay GS0499
    /// after the array/slice lift (no #3293 regression).
    /// </summary>
    [Theory]
    [InlineData("m[1].X += 5")]
    [InlineData("m[1].X++")]
    public void CrossCellMapCompoundShapesStayRejected(string writeCell)
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar m = map[int, P]{1: P{}}");

        var result = engine.Evaluate(writeCell);
        Assert.True(result.HasError, $"cell '{writeCell}' bound without error — the write would silently drop");
        Assert.Contains(
            result.Diagnostics,
            d => d.ToString().Contains(StructTemporaryMessageFragment, System.StringComparison.Ordinal));
    }

    /// <summary>
    /// Rvalue-collection guard: the array reference itself may be produced
    /// by a call — the element write mutates that heap array (C# parity;
    /// the write is observable through the alias).
    /// </summary>
    [Fact]
    public void ElementWriteThroughAliasedCallResultArrayIsObservable()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(
            "struct P { var X int }\n"
            + "var backing = []P{P{}, P{}}\n"
            + "func grab() []P { return backing }\n"
            + "grab()[1].X = 13\n"
            + "backing[1].X");
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(13, result.Value);
    }

    private static void AssertOk(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, $"cell '{cell}': {string.Join("; ", result.Diagnostics)}");
    }
}
