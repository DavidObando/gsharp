// <copyright file="Issue1639NarrowingInvalidationFastPathTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit

/// Issue #1639 — `InvalidateNarrowingsForAssignedVariables` used to walk
/// every statement's full syntax subtree twice (once via
/// `CollectAssignedNames`, once via `StatementMayMutateMemberPaths`)
/// even when zero narrowings were active, because
/// `BinderContext.NarrowedVariables.Count == 0` never fires — a block
/// pushes a (usually empty) persistent frame unconditionally. The fix adds a
/// real "any frame non-empty" fast-path guard and merges the two walks into
/// one. These tests pin the invariant: no active narrowing ⇒ the walk is
/// skipped with no diagnostic change, and whenever a narrowing IS active,
/// invalidation behaves exactly as before — including across nested blocks,
/// loops, and branches, and for both plain-variable and member-path
/// narrowings.
open class Issue1639NarrowingInvalidationFastPathTests {
    @Fact
    func NoActiveNarrowing_PlainStatements_FastPathProducesNoDiagnostics() {
        // No `is`/nil-guard/assignment narrowing is ever established here, so
        // every block's persistent frame stays empty for the whole function.
        // This exercises the fast path (HasAnyActiveNarrowings == false) on a
        // variety of statement shapes: plain assignment, a call, a loop, and a
        // branch — none of which should trigger a syntax walk, and none of
        // which should change binding results.
        let result = Evaluate(`
class C {
    func Helper() int32 { return 1 }
    func F(n int32) int32 {
        var total = 0
        var i = 0
        while i < n {
            total = total + Helper()
            i = i + 1
        }
        if total > 0 {
            total = total + 1
        }
        return total
    }
}
C{}.F(3)
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ActiveLocalNarrowing_InvalidatingAssignment_StillInvalidates() {
        // A narrowing is active (assignment smart cast on `x`); a subsequent
        // possibly-null reassignment must still clear it, even with the new
        // fast-path guard in place.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = fresh
        x = maybe
        return x.M()
    }
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("M", StringComparison.Ordinal))
    }

    @Fact
    func ActiveLocalNarrowing_NonInvalidatingStatement_NarrowingSurvives() {
        // Control for the above: with the same active narrowing, a statement
        // that does NOT reassign `x` must leave the narrowing intact.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        var unrelated = 1
        return x.M() + unrelated
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ActiveMemberPathNarrowing_InterveningMemberAssignment_StillInvalidates() {
        // Mirrors Issue1180's member-path invalidation coverage: an active
        // member-path narrowing must still be dropped by an intervening
        // member-mutating assignment, exercising the merged single-pass walk.
        let result = Evaluate(`
open class Animal { var Name string }
class Dog : Animal { func Bark() string { return "woof" } }
class Box { var Other int32 = 0 let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return "" }
    b.Other = 1
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func ActiveNarrowing_InvalidatedInsideNestedLoopAndBranch_DoesNotEscape() {
        // The narrowing on `x` is invalidated by a reassignment nested two
        // levels deep (inside an if inside a while). The invalidation must
        // still propagate to all active frames (per-block persistent frames
        // up the stack), so the member access after the loop sees the
        // original nullable type again.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?, n int32) int32 {
        var x E? = nil
        x = fresh
        var i = 0
        while i < n {
            if i == 0 {
                x = maybe
            }
            i = i + 1
        }
        return x.M()
    }
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("M", StringComparison.Ordinal))
    }

    @Fact
    func ActiveNarrowing_ReNarrowedInsideBranch_ReachesNestedBlock() {
        // Positive nested-block control: narrowing established, then
        // re-affirmed inside a branch, must still reach a further-nested
        // block without any diagnostic.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        if true {
            x = fresh
            if true {
                return x.M()
            }
        }
        return 0
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
