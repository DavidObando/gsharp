// <copyright file="Issue3292InPlaceIndexedStructWriteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Repl.Engine
import System
import Xunit

/// Issue #3292 (follow-up to #3252, part of #3163): in-place
/// (`ldelema`-rooted) struct member writes through indexed array/slice
/// elements. Complements the shape matrix in
/// (cref:Issue3252IndexedStructMemberWriteTests) with the properties
/// that make the lift SAFE: once-only evaluation of side-effecting index
/// (and collection) expressions on every write shape — the compound form
/// re-emits the element address chain on its read and write sides, so the
/// side-effecting parts must be hoisted exactly once by the
/// `SideEffectSpiller` — plus the `let`-binding heap-mutation
/// rule, property-setter writes through elements, and the map guards.
class Issue3292InPlaceIndexedStructWriteTests {
    /// Same-cell once-only: a side-effecting index expression in a SIMPLE
    /// element member write is evaluated exactly once, and the write lands
    /// in the element it selected.
    @Fact
    func SameCellSimpleWriteEvaluatesSideEffectingIndexOnce() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(CounterDecls + `
ps[idx()].X = 11
calls * 100 + ps[0].X`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(111, result.Value)
    }

    /// Same-cell once-only: a side-effecting index expression in a COMPOUND
    /// element member write (`ps[idx()].X += v` — the shape whose read and
    /// write sides share the element receiver) is evaluated exactly once.
    @Fact
    func SameCellCompoundWriteEvaluatesSideEffectingIndexOnce() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(CounterDecls + `
ps[idx()].X += 5
calls * 100 + ps[0].X`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(105, result.Value)
    }

    /// Same-cell once-only: increment flavor (`ps[idx()].X++`).
    @Fact
    func SameCellIncrementEvaluatesSideEffectingIndexOnce() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(CounterDecls + `
ps[idx()].X++
calls * 100 + ps[0].X`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(101, result.Value)
    }

    /// Same-cell once-only through a NESTED chain
    /// (`ns[idx()].B2.C += v`): the field walk over the element address
    /// re-emits the chain per side, so the index must still fire once.
    @Fact
    func SameCellNestedCompoundWriteEvaluatesSideEffectingIndexOnce() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(
            "struct B { var C int }\n" +
                "struct A2 { var B2 B }\n" +
                "var calls = 0\n" +
                "func idx() int {\n" +
                "    calls = calls + 1\n" +
                "    return 0\n" +
                "}\n" +
                "var ns = [2]A2{}\n" +
                "ns[idx()].B2.C += 8\n" +
                "calls * 100 + ns[0].B2.C"
        )
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(108, result.Value)
    }

    /// Same-cell once-only: a mutating method call through a side-effecting
    /// index (`ps[idx()].Bump()`) evaluates the index exactly once and
    /// mutates the selected element in place.
    @Fact
    func SameCellMutatingMethodEvaluatesSideEffectingIndexOnce() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(`struct P { var X int
 func Bump() { this.X = this.X + 1 } }
` + "var calls = 0\n" + "func idx() int {\n" + "    calls = calls + 1\n" + "    return 0\n" + "}\n" + "var ps = [2]P{}\n" + "ps[idx()].Bump()\n" + "calls * 100 + ps[0].X")
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(101, result.Value)
    }

    /// Cross-cell once-only: compound element member write through a
    /// prior-cell global with a side-effecting index — the ADR-0156 seam
    /// path (CLR member-write chain) must hoist the index exactly once too.
    @Fact
    func CrossCellCompoundWriteEvaluatesSideEffectingIndexOnce() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, CounterDecls)
        AssertOk(engine, "ps[idx()].X += 5")
        let probe = engine.Evaluate("calls * 100 + ps[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(105, probe.Value)
    }

    /// Cross-cell once-only: simple element member write.
    @Fact
    func CrossCellSimpleWriteEvaluatesSideEffectingIndexOnce() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, CounterDecls)
        AssertOk(engine, "ps[idx()].X = 11")
        let probe = engine.Evaluate("calls * 100 + ps[0].X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(111, probe.Value)
    }

    /// Issue #1132 shallow-immutability parity: `let` binds the VARIABLE,
    /// not the heap array it references — `ls[0] = v` is legal on a `let`
    /// array today, so the element member write (same storage, same heap
    /// mutation) is legal too and lands in place.
    @Fact
    func LetArrayElementMemberWriteMutatesHeapArrayInPlace() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(`struct P { var X int }
let ls = [2]P{}
ls[0].X = 5
ls[0].X`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(5, result.Value)
    }

    /// Property-setter writes through an array element previously mutated a
    /// spilled COPY silently (the receiver was hoisted to a temp before the
    /// setter call). With the element-address receiver path the setter runs
    /// against the stored element — matching C#'s `arr[i].Prop = v`.
    @Fact
    func SameCellPropertySetterThroughElementMutatesInPlace() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(
            "struct P {\n" +
                "    var x int\n" +
                "    prop X int {\n" +
                "        get { return x }\n" +
                "        set { x = value }\n" +
                "    }\n" +
                "}\n" +
                "var ps = [2]P{}\n" +
                "ps[0].X = 7\n" +
                "ps[0].x"
        )
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(7, result.Value)
    }

    /// Map guard: the side-effecting-index shapes over a MAP stay rejected
    /// (GS0499) — the lift is strictly array-backed.
    @Theory
    @InlineData(`struct P { var X int }
var m = map[int, P]{1: P{}}
m[1].X += 5`)
    @InlineData(`struct P { var X int }
var m = map[int, P]{1: P{}}
m[1].X++`)
    func SameCellMapCompoundShapesStayRejected(cell string) {
        using let engine = EmittedSessionEngine()
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

    /// Cross-cell map guard: compound and increment map arms stay GS0499
    /// after the array/slice lift (no #3293 regression).
    @Theory
    @InlineData("m[1].X += 5")
    @InlineData("m[1].X++")
    func CrossCellMapCompoundShapesStayRejected(writeCell string) {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "struct P { var X int }\nvar m = map[int, P]{1: P{}}")
        let result = engine.Evaluate(writeCell)
        Assert.True(result.HasError, "cell '$writeCell' bound without error — the write would silently drop")
        Assert.Contains(
            result.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString().Contains(
                StructTemporaryMessageFragment,
                StringComparison.Ordinal
            )
        )
    }

    /// Rvalue-collection guard: the array reference itself may be produced
    /// by a call — the element write mutates that heap array (C# parity;
    /// the write is observable through the alias).
    @Fact
    func ElementWriteThroughAliasedCallResultArrayIsObservable() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(
            "struct P { var X int }\n" +
                "var backing = []P{P{}, P{}}\n" +
                "func grab() []P { return backing }\n" +
                "grab()[1].X = 13\n" +
                "backing[1].X"
        )
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(13, result.Value)
    }

    shared {
        private const StructTemporaryMessageFragment string = "not writable storage"
        private const CounterDecls string = "struct P { var X int }\n" +
            "var calls = 0\n" +
            "func idx() int {\n" +
            "    calls = calls + 1\n" +
            "    return 0\n" +
            "}\n" +
            "var ps = [2]P{}"

        private func AssertOk(engine EmittedSessionEngine, cell string) {
            let result = engine.Evaluate(cell)
            Assert.False(result.HasError, "cell '$cell': ${string.Join("; ", result.Diagnostics)}")
        }
    }
}
