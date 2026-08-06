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
/// stored into the copy. The identical same-cell shape is rejected cleanly
/// with GS0499 (struct-temporary receiver, not writable storage). These
/// tests pin cross-cell/same-cell parity across the shape matrix: simple,
/// compound, and increment element-member writes; nested struct chains;
/// array, slice, and map collections. The mutating-method shape
/// (<c>ps[0].Bump()</c>) operates on an element copy in BOTH same-cell and
/// cross-cell form (the pre-existing language rule), so it stays observable
/// but unchanged, and reference-typed (class) elements stay writable
/// through the element reference.
/// </summary>
public sealed class Issue3252IndexedStructMemberWriteTests
{
    private const string StructTemporaryMessageFragment = "not writable storage";

    /// <summary>
    /// The user's exact repro: a simple struct-field write through an
    /// indexed element of a prior-cell array-of-struct global must report
    /// GS0499 (same-cell parity) instead of silently writing a copy.
    /// </summary>
    [Fact]
    public void CrossCellArrayElementStructFieldWriteReportsGs0499()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}");

        AssertStructTemporaryError(engine, "ps[0].X = 7");

        var probe = engine.Evaluate("ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
    }

    /// <summary>
    /// Compound flavor (<c>ps[0].X += v</c>): same silent-drop class, same
    /// GS0499 parity requirement.
    /// </summary>
    [Fact]
    public void CrossCellArrayElementStructFieldCompoundWriteReportsGs0499()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}");

        AssertStructTemporaryError(engine, "ps[0].X += 7");
    }

    /// <summary>
    /// Increment flavor (<c>ps[0].X++</c>): desugars through the compound
    /// chain path; must report GS0499 like its same-cell twin.
    /// </summary>
    [Fact]
    public void CrossCellArrayElementStructFieldIncrementReportsGs0499()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}");

        AssertStructTemporaryError(engine, "ps[0].X++");
    }

    /// <summary>
    /// Nested chain (<c>qs[0].B2.C = v</c>): the value-typed field walk
    /// bottoms out in a copied element, so the write must be blocked too.
    /// </summary>
    [Fact]
    public void CrossCellNestedStructFieldWriteThroughElementReportsGs0499()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct B { var C int }\nstruct A2 { var B2 B }\nvar qs = [2]A2{}");

        AssertStructTemporaryError(engine, "qs[0].B2.C = 7");
    }

    /// <summary>
    /// Map-of-struct flavor (<c>m[k].X = v</c>): a map element load is a
    /// copy in the same way; same-cell reports GS0499, cross-cell must too.
    /// </summary>
    [Fact]
    public void CrossCellMapElementStructFieldWriteReportsGs0499()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar m = map[int, P]{1: P{}}");

        AssertStructTemporaryError(engine, "m[1].X = 7");
    }

    /// <summary>
    /// Slice-of-struct flavor (<c>ss[0].X = v</c>).
    /// </summary>
    [Fact]
    public void CrossCellSliceElementStructFieldWriteReportsGs0499()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "struct P { var X int }\nvar ss = []P{P{}, P{}}");

        AssertStructTemporaryError(engine, "ss[0].X = 7");
    }

    /// <summary>
    /// Same-cell parity pins: the identical shapes in a single cell report
    /// GS0499 on main already — pinned so the parity target can't drift.
    /// </summary>
    [Theory]
    [InlineData("struct P { var X int }\nvar ps = [2]P{}\nps[0].X = 7")]
    [InlineData("struct P { var X int }\nvar ps = [2]P{}\nps[0].X += 7")]
    [InlineData("struct P { var X int }\nvar ps = [2]P{}\nps[0].X++")]
    [InlineData("struct B { var C int }\nstruct A2 { var B2 B }\nvar qs = [2]A2{}\nqs[0].B2.C = 7")]
    [InlineData("struct P { var X int }\nvar m = map[int, P]{1: P{}}\nm[1].X = 7")]
    [InlineData("struct P { var X int }\nvar ss = []P{P{}, P{}}\nss[0].X = 7")]
    public void SameCellIndexedStructMemberWriteReportsGs0499(string cell)
    {
        using var engine = new EmittedSessionEngine();
        AssertStructTemporaryError(engine, cell);
    }

    /// <summary>
    /// Mutating-method parity: calling a mutating method on an indexed
    /// element operates on an element COPY in both same-cell and cross-cell
    /// form (the pre-existing language rule for method receivers). Pinned so
    /// the seam fix doesn't change the method shape's semantics in either
    /// direction.
    /// </summary>
    [Fact]
    public void MutatingMethodOnIndexedElementOperatesOnCopyInBothForms()
    {
        const string decls = "struct P { var X int\n func Bump() { this.X = this.X + 1 } }\nvar ps = [2]P{}";

        using var sameCell = new EmittedSessionEngine();
        var same = sameCell.Evaluate(decls + "\nps[0].Bump()\nps[0].X");
        Assert.False(same.HasError, string.Join("; ", same.Diagnostics));
        Assert.Equal(0, same.Value);

        using var crossCell = new EmittedSessionEngine();
        AssertOk(crossCell, decls);
        AssertOk(crossCell, "ps[0].Bump()");
        var probe = crossCell.Evaluate("ps[0].X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
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
    /// The diagnostic's suggested remedy stays viable across cells: copy the
    /// element to a mutable local, mutate it, and store it back through the
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
