// <copyright file="Issue3252IndexedStructMemberWriteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3252 (ADR-0156 Phase 2 seam, part of #3176/#3163): a struct-field
/// write through an indexed element of a prior-cell global
/// (<c>ps[0].X = v</c>) bound successfully and SILENTLY DROPPED the write —
/// the chain path evaluated the element into a value-typed temporary and
/// stored into the copy. Issue #3252's fix standardized those shapes on the
/// same-cell GS0499 rejection; issue #3292 then lifted the rejection for
/// ARRAY-BACKED collections (arrays and slices) by rooting the write chain
/// at the element address (<c>ldelema</c>), in both same-cell and cross-cell
/// form. These tests pin the resulting matrix: array/slice element member
/// writes (simple, compound, increment, nested) mutate the stored element in
/// place with cross-cell/same-cell parity; map elements (no element address —
/// the Dictionary indexer returns a copy) keep the GS0499 struct-temporary
/// rejection in both forms; and reference-typed (class) elements stay
/// writable through the element reference.
/// </summary>
public sealed class Issue3252IndexedStructMemberWriteTests
{
    private const string StructTemporaryMessageFragment = "not writable storage";

    /// <summary>
    /// Issue #3292: the original #3252 repro now writes in place — a simple
    /// struct-field write through an indexed element of a prior-cell
    /// array-of-struct global mutates the stored element.
    /// </summary>
    [Fact]
    public void CrossCellArrayElementStructFieldWriteMutatesInPlace()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}");
        AssertOk(engine, "ps[0].X = 7");

        var probe = engine.Evaluate("ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(7, probe.Value);
    }

    /// <summary>
    /// Compound flavor (<c>ps[0].X += v</c>): issue #3292 in-place write.
    /// </summary>
    [Fact]
    public void CrossCellArrayElementStructFieldCompoundWriteMutatesInPlace()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}");
        AssertOk(engine, "ps[0].X = 2");
        AssertOk(engine, "ps[0].X += 7");

        var probe = engine.Evaluate("ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(9, probe.Value);
    }

    /// <summary>
    /// Increment flavor (<c>ps[0].X++</c>): desugars through the compound
    /// chain path; issue #3292 in-place write.
    /// </summary>
    [Fact]
    public void CrossCellArrayElementStructFieldIncrementMutatesInPlace()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}");
        AssertOk(engine, "ps[0].X++");

        var probe = engine.Evaluate("ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(1, probe.Value);
    }

    /// <summary>
    /// Nested chain (<c>qs[0].B2.C = v</c>): the value-typed field walk now
    /// roots at the element address (<c>ldelema</c> + <c>ldflda</c>), so the
    /// write reaches the stored element in place (issue #3292).
    /// </summary>
    [Fact]
    public void CrossCellNestedStructFieldWriteThroughElementMutatesInPlace()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct B { var C int }\nstruct A2 { var B2 B }\nvar qs = [2]A2{}");
        AssertOk(engine, "qs[0].B2.C = 7");

        var probe = engine.Evaluate("qs[0].B2.C");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(7, probe.Value);
    }

    /// <summary>
    /// Map-of-struct flavor (<c>m[k].X = v</c>): a map element load is a
    /// copy (the Dictionary indexer getter — no element address exists), so
    /// the GS0499 rejection stays, cross-cell and same-cell alike
    /// (issue #3292 keeps the map arm blocked; mirrors C#'s CS1612).
    /// </summary>
    [Fact]
    public void CrossCellMapElementStructFieldWriteReportsGs0499()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar m = map[int, P]{1: P{}}");

        AssertStructTemporaryError(engine, "m[1].X = 7");
    }

    /// <summary>
    /// Slice-of-struct flavor (<c>ss[0].X = v</c>): slices are CLR-array
    /// backed (ADR-0016), so the element address path applies and the write
    /// lands in place (issue #3292).
    /// </summary>
    [Fact]
    public void CrossCellSliceElementStructFieldWriteMutatesInPlace()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ss = []P{P{}, P{}}");
        AssertOk(engine, "ss[0].X = 7");

        var probe = engine.Evaluate("ss[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(7, probe.Value);
    }

    /// <summary>
    /// Same-cell parity: the identical array/slice shapes write in place
    /// within a single cell (issue #3292 lifts the same-cell GS0499 the
    /// #3252 matrix pinned), while the map shape keeps its rejection.
    /// </summary>
    [Theory]
    [InlineData("struct P { var X int }\nvar ps = [2]P{}\nps[0].X = 7\nps[0].X", 7)]
    [InlineData("struct P { var X int }\nvar ps = [2]P{}\nps[0].X += 7\nps[0].X", 7)]
    [InlineData("struct P { var X int }\nvar ps = [2]P{}\nps[0].X++\nps[0].X", 1)]
    [InlineData("struct B { var C int }\nstruct A2 { var B2 B }\nvar qs = [2]A2{}\nqs[0].B2.C = 7\nqs[0].B2.C", 7)]
    [InlineData("struct P { var X int }\nvar ss = []P{P{}, P{}}\nss[0].X = 7\nss[0].X", 7)]
    public void SameCellIndexedStructMemberWriteMutatesInPlace(string cell, int expected)
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, $"cell '{cell}': {string.Join("; ", result.Diagnostics)}");
        Assert.Equal(expected, result.Value);
    }

    /// <summary>
    /// Same-cell map parity pin: the map shape reports GS0499 in a single
    /// cell too — the map arm of #3252 is not lifted by #3292.
    /// </summary>
    [Fact]
    public void SameCellMapElementStructMemberWriteReportsGs0499()
    {
        using var engine = new EmittedSessionEngine();
        AssertStructTemporaryError(engine, "struct P { var X int }\nvar m = map[int, P]{1: P{}}\nm[1].X = 7");
    }

    /// <summary>
    /// Mutating-method parity (issue #3292): calling a mutating method on an
    /// array element now operates on the element IN PLACE in both same-cell
    /// and cross-cell form — the receiver is loaded by element address
    /// (<c>ldelema</c>), exactly as C# does for <c>arr[i].M()</c>.
    /// </summary>
    [Fact]
    public void MutatingMethodOnIndexedElementMutatesInPlaceInBothForms()
    {
        const string decls = "struct P { var X int\n func Bump() { this.X = this.X + 1 } }\nvar ps = [2]P{}";

        using var sameCell = new EmittedSessionEngine();
        var same = sameCell.Evaluate(decls + "\nps[0].Bump()\nps[0].X");
        Assert.False(same.HasError, string.Join("; ", same.Diagnostics));
        Assert.Equal(1, same.Value);

        using var crossCell = new EmittedSessionEngine();
        AssertOk(crossCell, decls);
        AssertOk(crossCell, "ps[0].Bump()");
        var probe = crossCell.Evaluate("ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(1, probe.Value);
    }

    /// <summary>
    /// Mutating-method map guard: a map element has no address, so the
    /// element-address receiver path must not leak into map elements. Today
    /// a mutating method call on a map element fails outright with a
    /// PRE-EXISTING emitter error (GS9998 NullReferenceException — present
    /// on main before #3292, reproducible with `gsc` on
    /// <c>m[1].Bump()</c>; tracked as issue #3301); pinned here only as
    /// "does not silently succeed", so a change in either direction (fix or
    /// in-place leak) is caught.
    /// </summary>
    [Fact]
    public void MutatingMethodOnMapElementDoesNotSilentlySucceed()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate(
            "struct P { var X int\n func Bump() { this.X = this.X + 1 } }\nvar m = map[int, P]{1: P{}}\nm[1].Bump()\nm[1].X");
        Assert.True(result.HasError, "map-element mutating call unexpectedly succeeded — semantics changed");
    }

    /// <summary>
    /// Reference-typed (class) elements are NOT struct temporaries: a member
    /// write through an indexed element of a prior-cell array-of-class
    /// global mutates the referenced heap object and must keep working.
    /// </summary>
    [Fact]
    public void CrossCellClassElementMemberWriteStillMutatesHeapObject()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "class C { var X int }\nvar cs = []C{C{}, C{}}");
        AssertOk(engine, "cs[0].X = 7");

        var probe = engine.Evaluate("cs[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(7, probe.Value);
    }

    /// <summary>
    /// The historical remedy stays viable across cells: copy the element to
    /// a mutable local, mutate it, and store it back through the
    /// whole-element index assignment (#3251's seam).
    /// </summary>
    [Fact]
    public void CrossCellRemedyCopyMutateStoreBackWorks()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}");
        AssertOk(engine, "var tmp = ps[0]\ntmp.X = 7\nps[0] = tmp");

        var probe = engine.Evaluate("ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(7, probe.Value);
    }

    /// <summary>
    /// Guard: whole-variable member writes through a prior-cell struct
    /// global (issue #3185's addressable path, no indexing) stay writable
    /// in place.
    /// </summary>
    [Fact]
    public void CrossCellDirectStructGlobalMemberWriteStillMutatesInPlace()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar p = P{}");
        AssertOk(engine, "p.X = 7");

        var probe = engine.Evaluate("p.X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(7, probe.Value);
    }

    private static void AssertOk(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, $"cell '{cell}': {string.Join("; ", result.Diagnostics)}");
    }

    private static void AssertStructTemporaryError(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.True(result.HasError, $"cell '{cell}' bound without error — the write would silently drop");
        Assert.Contains(
            result.Diagnostics,
            d => d.ToString().Contains(StructTemporaryMessageFragment, System.StringComparison.Ordinal));
    }
}
