// <copyright file="Issue3252IndexedStructMemberWriteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Repl.Engine
import System
import Xunit

/// Issue #3252 (ADR-0156 Phase 2 seam, part of #3176/#3163): a struct-field
/// write through an indexed element of a prior-cell global
/// (`ps[0].X = v`) bound successfully and SILENTLY DROPPED the write —
/// the chain path evaluated the element into a value-typed temporary and
/// stored into the copy. Issue #3252's fix standardized those shapes on the
/// same-cell GS0499 rejection; issue #3292 then lifted the rejection for
/// ARRAY-BACKED collections (arrays and slices) by rooting the write chain
/// at the element address (`ldelema`), in both same-cell and cross-cell
/// form. These tests pin the resulting matrix: array/slice element member
/// writes (simple, compound, increment, nested) mutate the stored element in
/// place with cross-cell/same-cell parity; map elements (no element address —
/// the Dictionary indexer returns a copy) keep the GS0499 struct-temporary
/// rejection in both forms; and reference-typed (class) elements stay
/// writable through the element reference.
class Issue3252IndexedStructMemberWriteTests {
    /// Issue #3292: the original #3252 repro now writes in place — a simple
    /// struct-field write through an indexed element of a prior-cell
    /// array-of-struct global mutates the stored element.
    @Fact
    func CrossCellArrayElementStructFieldWriteMutatesInPlace() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}")
        AssertOk(engine, "ps[0].X = 7")
        let probe = engine.Evaluate("ps[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(7, probe.Value)
    }

    /// Compound flavor (`ps[0].X += v`): issue #3292 in-place write.
    @Fact
    func CrossCellArrayElementStructFieldCompoundWriteMutatesInPlace() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}")
        AssertOk(engine, "ps[0].X = 2")
        AssertOk(engine, "ps[0].X += 7")
        let probe = engine.Evaluate("ps[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(9, probe.Value)
    }

    /// Increment flavor (`ps[0].X++`): desugars through the compound
    /// chain path; issue #3292 in-place write.
    @Fact
    func CrossCellArrayElementStructFieldIncrementMutatesInPlace() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}")
        AssertOk(engine, "ps[0].X++")
        let probe = engine.Evaluate("ps[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(1, probe.Value)
    }

    /// Nested chain (`qs[0].B2.C = v`): the value-typed field walk now
    /// roots at the element address (`ldelema` + `ldflda`), so the
    /// write reaches the stored element in place (issue #3292).
    @Fact
    func CrossCellNestedStructFieldWriteThroughElementMutatesInPlace() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct B { var C int }
struct A2 { var B2 B }
var qs = [2]A2{}`)
        AssertOk(engine, "qs[0].B2.C = 7")
        let probe = engine.Evaluate("qs[0].B2.C")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(7, probe.Value)
    }

    /// Map-of-struct flavor (`m[k].X = v`): a map element load is a
    /// copy (the Dictionary indexer getter — no element address exists), so
    /// the GS0499 rejection stays, cross-cell and same-cell alike
    /// (issue #3292 keeps the map arm blocked; mirrors C#'s CS1612).
    @Fact
    func CrossCellMapElementStructFieldWriteReportsGs0499() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "struct P { var X int }\nvar m = map[int, P]{1: P{}}")
        AssertStructTemporaryError(engine, "m[1].X = 7")
    }

    /// Slice-of-struct flavor (`ss[0].X = v`): slices are CLR-array
    /// backed (ADR-0016), so the element address path applies and the write
    /// lands in place (issue #3292).
    @Fact
    func CrossCellSliceElementStructFieldWriteMutatesInPlace() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "struct P { var X int }\nvar ss = []P{P{}, P{}}")
        AssertOk(engine, "ss[0].X = 7")
        let probe = engine.Evaluate("ss[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(7, probe.Value)
    }

    /// Same-cell parity: the identical array/slice shapes write in place
    /// within a single cell (issue #3292 lifts the same-cell GS0499 the
    /// #3252 matrix pinned), while the map shape keeps its rejection.
    @Theory
    @InlineData(`struct P { var X int }
var ps = [2]P{}
ps[0].X = 7
ps[0].X`, int32(7))
    @InlineData(`struct P { var X int }
var ps = [2]P{}
ps[0].X += 7
ps[0].X`, int32(7))
    @InlineData(`struct P { var X int }
var ps = [2]P{}
ps[0].X++
ps[0].X`, int32(1))
    @InlineData(`struct B { var C int }
struct A2 { var B2 B }
var qs = [2]A2{}
qs[0].B2.C = 7
qs[0].B2.C`, int32(7))
    @InlineData(`struct P { var X int }
var ss = []P{P{}, P{}}
ss[0].X = 7
ss[0].X`, int32(7))
    func SameCellIndexedStructMemberWriteMutatesInPlace(cell string, expected int32) {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(cell)
        Assert.False(result.HasError, "cell '$cell': ${string.Join("; ", result.Diagnostics)}")
        Assert.Equal(expected, result.Value)
    }

    /// Same-cell map parity pin: the map shape reports GS0499 in a single
    /// cell too — the map arm of #3252 is not lifted by #3292.
    @Fact
    func SameCellMapElementStructMemberWriteReportsGs0499() {
        using let engine = EmittedSessionEngine()
        AssertStructTemporaryError(engine, `struct P { var X int }
var m = map[int, P]{1: P{}}
m[1].X = 7`)
    }

    /// Mutating-method parity (issue #3292): calling a mutating method on an
    /// array element now operates on the element IN PLACE in both same-cell
    /// and cross-cell form — the receiver is loaded by element address
    /// (`ldelema`), exactly as C# does for `arr[i].M()`.
    @Fact
    func MutatingMethodOnIndexedElementMutatesInPlaceInBothForms() {
        const decls = `struct P { var X int
 func Bump() { this.X = this.X + 1 } }
var ps = [2]P{}`
        using let sameCell = EmittedSessionEngine()
        let same = sameCell.Evaluate(decls + `
ps[0].Bump()
ps[0].X`)
        Assert.False(same.HasError, string.Join("; ", same.Diagnostics))
        Assert.Equal(1, same.Value)
        using let crossCell = EmittedSessionEngine()
        AssertOk(crossCell, decls)
        AssertOk(crossCell, "ps[0].Bump()")
        let probe = crossCell.Evaluate("ps[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(1, probe.Value)
    }

    /// Mutating-method map arm (issue #3301): a map element has no address
    /// (the Dictionary indexer returns a copy), so the element-address
    /// receiver path must not leak into map elements. A mutating method
    /// call on a map element instead operates on the returned COPY and the
    /// mutation is discarded — C# parity for `dict[k].M()` and the
    /// same rvalue-receiver semantics G# already gives
    /// `MakeItem().Bump()`. Previously this crashed the emitter with
    /// GS9998 (NullReferenceException in EmitMapIndexRead: a map keyed or
    /// valued by a same-cell user struct has a null `ClrType`).
    @Fact
    func SameCellMutatingMethodOnMapElementCallsOnCopyAndDiscardsMutation() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(`struct P { var X int
 func Bump() { this.X = this.X + 1 } }
var m = map[int, P]{1: P{}}
m[1].Bump()
m[1].X`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(0, result.Value)
    }

    /// Cross-cell flavor of the #3301 map arm: the mutating call through a
    /// prior-cell submission-global map also runs on the element copy and
    /// discards the mutation — parity with the same-cell form, and the
    /// deliberate contrast with the in-place #3292 array/slice arm.
    @Fact
    func CrossCellMutatingMethodOnMapElementCallsOnCopyAndDiscardsMutation() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct P { var X int
 func Bump() { this.X = this.X + 1 } }
var m = map[int, P]{1: P{}}`)
        AssertOk(engine, "m[1].Bump()")
        let probe = engine.Evaluate("m[1].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(0, probe.Value)
    }

    /// Non-mutating method calls on a map element read through the same
    /// copy receiver; #3301's fix must keep (same-cell) and leave
    /// (cross-cell) them working.
    @Fact
    func NonMutatingMethodOnMapElementReturnsValueInBothForms() {
        const decls = `struct P { var X int
 func Get() int { return this.X } }
var m = map[int, P]{1: P{X: 5}}`
        using let sameCell = EmittedSessionEngine()
        let same = sameCell.Evaluate(decls + "\nm[1].Get()")
        Assert.False(same.HasError, string.Join("; ", same.Diagnostics))
        Assert.Equal(5, same.Value)
        using let crossCell = EmittedSessionEngine()
        AssertOk(crossCell, decls)
        let probe = crossCell.Evaluate("m[1].Get()")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(5, probe.Value)
    }

    /// Reference-typed (class) elements are NOT struct temporaries: a member
    /// write through an indexed element of a prior-cell array-of-class
    /// global mutates the referenced heap object and must keep working.
    @Fact
    func CrossCellClassElementMemberWriteStillMutatesHeapObject() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "class C { var X int }\nvar cs = []C{C{}, C{}}")
        AssertOk(engine, "cs[0].X = 7")
        let probe = engine.Evaluate("cs[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(7, probe.Value)
    }

    /// The historical remedy stays viable across cells: copy the element to
    /// a mutable local, mutate it, and store it back through the
    /// whole-element index assignment (#3251's seam).
    @Fact
    func CrossCellRemedyCopyMutateStoreBackWorks() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "struct P { var X int }\nvar ps = [2]P{}")
        AssertOk(engine, `var tmp = ps[0]
tmp.X = 7
ps[0] = tmp`)
        let probe = engine.Evaluate("ps[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(7, probe.Value)
    }

    /// Guard: whole-variable member writes through a prior-cell struct
    /// global (issue #3185's addressable path, no indexing) stay writable
    /// in place.
    @Fact
    func CrossCellDirectStructGlobalMemberWriteStillMutatesInPlace() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "struct P { var X int }\nvar p = P{}")
        AssertOk(engine, "p.X = 7")
        let probe = engine.Evaluate("p.X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(7, probe.Value)
    }

    shared {
        private const StructTemporaryMessageFragment string = "not writable storage"

        private func AssertOk(engine EmittedSessionEngine, cell string) {
            let result = engine.Evaluate(cell)
            Assert.False(result.HasError, "cell '$cell': ${string.Join("; ", result.Diagnostics)}")
        }

        private func AssertStructTemporaryError(engine EmittedSessionEngine, cell string) {
            let result = engine.Evaluate(cell)
            Assert.True(result.HasError, "cell '$cell' bound without error — the write would silently drop")
            Assert.Contains(
                result.Diagnostics,
                (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString().Contains(
                    StructTemporaryMessageFragment,
                    StringComparison.Ordinal
                )
            )
        }
    }
}
