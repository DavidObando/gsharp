// <copyright file="Issue3251IndexAssignmentSubmissionGlobalTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Repl.Engine
import System
import Xunit

/// Issue #3251 (ADR-0156 Phase 2 seam, part of #3176/#3163): a bare indexed
/// assignment (`name[i] = v`) whose target is a prior interactive
/// submission's global bound through a raw scope lookup and reported GS0125,
/// even though reads, whole-variable assignment, compound indexed assignment
/// (`name[i] += v`), and indexed increment (`name[i]++`) through
/// the same global all consulted the `SubmissionImports` fallback. The
/// gap is path-specific (the `IndexAssignmentExpressionSyntax` binder),
/// not scope-specific: top-level and loop-body forms failed identically.
/// These tests pin the user's exact repro plus the sibling lvalue-shape
/// matrix around it.
class Issue3251IndexAssignmentSubmissionGlobalTests {
    /// The user's exact session: a map global declared in one cell, assigned
    /// in the next, then populated element-by-element inside a
    /// `for`-statement body in a later cell.
    @Fact
    func ForBodyIndexedAssignmentToPriorCellMapGlobal() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var num = 42")
        AssertOk(engine, "func Fib(i int) long -> if i <= 0 { 0 } else if i == 1 { 1 } else { Fib(i-1)+Fib(i-2) }")
        AssertOk(engine, "var numbers map[int, long]")
        AssertOk(engine, "numbers = map[int, long]{}")
        AssertOk(engine, "for var i = 1; i <= 20; i++ {   numbers[i] = Fib(i) }")
        let read = engine.Evaluate("numbers[20]")
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics))
        Assert.Equal(6765L, read.Value)
    }

    /// The same shape at top level (no enclosing statement): proves the gap
    /// was the binder path, not nested-statement scoping, and pins the fix
    /// for both.
    @Fact
    func TopLevelIndexedAssignmentToPriorCellMapGlobal() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var m = map[int, long]{1: 10}")
        AssertOk(engine, "m[2] = 20")
        let read = engine.Evaluate("m[2]")
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics))
        Assert.Equal(20L, read.Value)
    }

    /// Array flavor of the same path: element store through a prior-cell
    /// array global mutates the stored array (the receiver is a reference).
    @Fact
    func IndexedAssignmentToPriorCellArrayGlobal() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var arr = [3]int{1, 2, 3}")
        AssertOk(engine, "arr[0] = 9")
        let read = engine.Evaluate("arr[0]")
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics))
        Assert.Equal(9, read.Value)
    }

    /// A `let` map global stays element-writable across cells, matching
    /// the same-cell rule (the write goes through the stored reference, not
    /// the read-only binding).
    @Fact
    func IndexedAssignmentToPriorCellLetMapGlobal() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "let lm = map[int, int]{1: 1}")
        AssertOk(engine, "lm[2] = 9")
        let read = engine.Evaluate("lm[2]")
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics))
        Assert.Equal(9, read.Value)
    }

    /// A current-cell declaration shadows the prior-cell global for the
    /// indexed write, mirroring the read-side newest-wins rule.
    @Fact
    func CurrentCellDeclarationShadowsPriorCellGlobal() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var m = map[int, int]{1: 1}")
        let shadowed = engine.Evaluate(`var m = map[int, int]{1: 100}
m[1] = 7
m[1]`)
        Assert.False(shadowed.HasError, string.Join("; ", shadowed.Diagnostics))
        Assert.Equal(7, shadowed.Value)
    }

    /// Sibling lvalue shapes that already consulted the fallback on main,
    /// pinned so the seam stays whole: compound indexed assignment, indexed
    /// increment, and a `ref` argument through an indexed element of a
    /// prior-cell global.
    @Fact
    func SiblingIndexedLvalueShapesThroughPriorCellGlobals() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var m = map[int, long]{1: 10}")
        let compound = engine.Evaluate("m[1] += 1")
        Assert.False(compound.HasError, string.Join("; ", compound.Diagnostics))
        Assert.Equal(11L, compound.Value)
        AssertOk(engine, "m[1]++")
        let read = engine.Evaluate("m[1]")
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics))
        Assert.Equal(12L, read.Value)
        AssertOk(engine, "var arr = [3]int{1, 2, 3}")
        AssertOk(engine, `func bump(ref n int) {
    n = n + 1
}`)
        let refArg = engine.Evaluate("bump(ref arr[1])\narr[1]")
        Assert.False(refArg.HasError, string.Join("; ", refArg.Diagnostics))
        Assert.Equal(3, refArg.Value)
    }

    /// An undefined bare indexed-assignment target still reports GS0125:
    /// the fallback only fires for names a prior submission declared.
    @Fact
    func UndefinedIndexedAssignmentTargetStillReportsGs0125() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var m = map[int, int]{1: 1}")
        let missing = engine.Evaluate("nope[1] = 2")
        Assert.True(missing.HasError)
        Assert.Contains(
            missing.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString().Contains(
                "'nope' doesn't exist",
                StringComparison.Ordinal
            )
        )
    }

    shared {
        private func AssertOk(engine EmittedSessionEngine, cell string) {
            let result = engine.Evaluate(cell)
            Assert.False(result.HasError, "cell '$cell': ${string.Join("; ", result.Diagnostics)}")
        }
    }
}
