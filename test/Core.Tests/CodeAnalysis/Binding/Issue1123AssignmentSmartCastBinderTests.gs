// <copyright file="Issue1123AssignmentSmartCastBinderTests.cs" company="GSharp">
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

/// Issue #1123 — Kotlin-style smart cast that narrows a nullable `var`
/// local to its non-nullable underlying type after the local is assigned a
/// statically non-nullable value. Mirrors the existing `if x is T` /
/// nil-guard smart-cast flow analysis, extended to assignment. Covers:
/// positive narrowing (straight-line and into nested blocks), re-narrowing,
/// the invalidation rules (reassigning to a possibly-null value clears the
/// narrowing), and a negative control (no narrowing without the assignment).
open class Issue1123AssignmentSmartCastBinderTests {
    @Fact
    func Assignment_OfNonNullValue_NarrowsNullableLocal() {
        // The minimal repro from the issue.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        return x.M()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Assignment_Narrowing_ReachesNestedBlock() {
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        if true {
            return x.M()
        }
        return 0
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Assignment_Narrowing_ReachesStraightLineStatements() {
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        var a = x.M()
        var b = x.M()
        return a + b
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Assignment_Narrowing_ToDerivedAssignedValue() {
        let result = Evaluate(`
open class Base { open func M() int32 { return 1 } }
class Derived : Base { override func M() int32 { return 2 } }
class C {
    func F(d Derived) int32 {
        var x Base? = nil
        x = d
        return x.M()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Assignment_ReassignToPossiblyNull_ClearsNarrowing() {
        // Re-assigning `x` to a possibly-null value drops the narrowing, so the
        // subsequent member access fails again.
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
    func Assignment_ReNarrows_AfterPossiblyNullThenNonNull() {
        // A possibly-null assignment clears the narrowing; a following non-null
        // assignment re-establishes it.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = maybe
        x = fresh
        return x.M()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NoAssignment_NegativeControl_DoesNotNarrow() {
        // Without the narrowing assignment, the member access on `E?` fails.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F() int32 {
        var x E? = nil
        return x.M()
    }
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("M", StringComparison.Ordinal))
    }

    @Fact
    func Assignment_NarrowingDoesNotEscapeBlock_AfterReassign() {
        // After re-assigning `x` to a possibly-null value the narrowing is gone
        // for the rest of the block, including nested blocks.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = fresh
        x = maybe
        if true {
            return x.M()
        }
        return 0
    }
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("M", StringComparison.Ordinal))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
