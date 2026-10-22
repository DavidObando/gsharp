// <copyright file="Issue5128StatementEffectSummaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #5128 — the narrowing pass computes one effect summary per statement.
/// Invalidation and the callable alias update read the same summary, so a
/// statement is walked once instead of twice. The counters
/// `narrowing.effect-walks` and `narrowing.effect-reuses` show which happened.
/// The narrowing results must not change, so every test also asserts the
/// diagnostics.
class Issue5128StatementEffectSummaryTests {
    @Fact
    func ActiveNarrowing_ReusesTheSummaryForTheAliasUpdate() {
        // `x = fresh` activates an assignment narrowing, so each later
        // statement reaches invalidation with a bound statement and then the
        // alias update. The second consumer must reuse the first one's walk.
        let (diagnostics, walks, reuses) = Bind(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        var n = x.M()
        n = n + x.M()
        n = n + x.M()
        return n
    }
}
`)
        Assert.Empty(diagnostics)
        Assert.True(walks > 0)
        Assert.True(reuses >= 3)
    }

    @Fact
    func NoActiveNarrowing_InvalidationSkipsTheWalk_SoNothingIsReused() {
        // Without a narrowing, invalidation returns before it asks for a
        // summary. Only the alias update walks, and there is nothing to share.
        let (diagnostics, walks, reuses) = Bind(`
class C {
    func F(a int32) int32 {
        var n = a
        n = n + 1
        n = n + 2
        return n
    }
}
`)
        Assert.Empty(diagnostics)
        Assert.True(walks > 0)
        Assert.Equal(0L, reuses)
    }

    @Fact
    func SharedSummary_InvalidatingAssignment_StillDropsNarrowing() {
        // The summary is shared and read-only. Invalidation must still drop the
        // narrowing of a root that the statement assigns.
        let (diagnostics, _, reuses) = Bind(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = fresh
        var a = x.M()
        x = maybe
        return a + x.M()
    }
}
`)
        Assert.True(reuses > 0)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("M", StringComparison.Ordinal))
    }

    @Fact
    func MemberPathNarrowing_DroppedByCallInNestedStatement() {
        // The member-mutation answer is cached per statement syntax. A call two
        // statements deep must still drop the member-path narrowing, and the
        // same statement must give the same answer on a second walk.
        let (diagnostics, _, _) = Bind(`
open class Animal { var Name string }
class Dog : Animal { func Bark() string { return "woof" } }
class Box { let Pet Animal }
func Touch() { }
func Run(b Box, c bool) string {
    if b.Pet !is Dog { return "" }
    if c {
        if c {
            Touch()
        }
    }
    return b.Pet.Bark()
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func MemberPathNarrowing_SurvivesNestedStatementsWithoutMutation() {
        let (diagnostics, _, _) = Bind(`
open class Animal { var Name string }
class Dog : Animal { func Bark() string { return "woof" } }
class Box { let Pet Animal }
func Run(b Box, c bool) string {
    var n = 0
    if b.Pet !is Dog { return "" }
    if c {
        if c {
            n = n + 1
        }
    }
    return b.Pet.Bark()
}
`)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string)(Diagnostics ImmutableArray[Diagnostic], Walks int64, Reuses int64) {
            using let measurements = CompilationMeasurements.Start("issue5128")
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            Assert.Empty(globalScope.Diagnostics)
            let program = Binder.BindProgram(globalScope)
            return (
                program.Diagnostics.ToImmutableArray(),
                measurements.GetCounter("narrowing.effect-walks"),
                measurements.GetCounter("narrowing.effect-reuses")
            )
        }
    }
}
