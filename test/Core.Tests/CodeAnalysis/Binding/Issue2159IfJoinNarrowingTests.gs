// <copyright file="Issue2159IfJoinNarrowingTests.cs" company="GSharp">
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

/// Issue #2159 — narrow a nullable `var` local to its non-nullable
/// underlying type at the JOIN point after an `if` when the local is
/// non-null on <em>every</em> branch exit (via assignment inside the branch
/// and/or condition-implied narrowing). Generalises the straight-line
/// assignment narrowing (issue #1123) and the early-exit narrowing
/// (issue #700) to the "null-check then reassign in the null branch" idiom.
/// Covers the positive repros, the generic form, the negative controls that
/// must still block narrowing, an `else if` chain, and post-if
/// re-nullable-ization.
open class Issue2159IfJoinNarrowingTests {
    @Fact
    func ReassignInNullBranch_NoElse_Narrows() {
        // Repro (1): non-null branch reached via the implicit negated-condition
        // else (`r != nil`); the then-branch reassigns `r` to a non-null value.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f1(s string?) string {
    var r string? = s
    if r == nil { r = mk() }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AssignNonNullInBothBranches_Narrows() {
        // Repro (2): then assigns a fresh non-null value; else assigns the
        // condition-narrowed (non-null) parameter.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f2(s string?) string {
    var r string?
    if s == nil { r = mk() } else { r = s }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericClassConstrained_Narrows() {
        // Repro (3): generic form; `T` carries a `class` constraint so `T?` → `T`
        // is a metadata-only narrowing.
        let result = Evaluate(`
package T
func f3[T class init()](s object?) T {
    var r T? = s as T
    if r == nil { r = T() }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ElseIfChain_EveryTerminalBranchNonNull_Narrows() {
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(a bool, s string?) string {
    var r string? = s
    if a { r = mk() } else if r == nil { r = mk() } else { r = mk() }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func EarlyExitInNullBranch_StillNarrows() {
        // Regression guard: the already-working early-exit idiom stays clean.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(s string?) string {
    var r string? = s
    if r == nil { return mk() }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UnrelatedBool_NoElse_DoesNotNarrow() {
        // Negative: the implicit else leaves `r` at its declared nullable type
        // because the condition does not narrow it.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(c bool) string {
    var r string?
    if c { r = mk() }
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    @Fact
    func EmptyThen_DoesNotNarrow() {
        // Negative: the then-branch leaves `r` nil.
        let result = Evaluate(`
package T
func f(s string?) string {
    var r string? = s
    if r == nil { }
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    @Fact
    func AssignNullableInBranch_DoesNotNarrow() {
        // Negative: the branch assigns a possibly-null value, so `r` is not
        // proven non-null on that exit.
        let result = Evaluate(`
package T
func maybe() string? -> nil
func f(s string?) string {
    var r string? = s
    if r == nil { r = maybe() }
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    @Fact
    func ReassignToNilAfterNonNull_DoesNotNarrow() {
        // Negative: a later reassignment to nil inside the branch clears the
        // non-null fact established by the earlier assignment.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(s string?) string {
    var r string? = s
    if r == nil {
        r = mk()
        r = nil
    }
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    @Fact
    func PostIfReassignToNull_ReNullableIzes() {
        // The join narrows `r`, but a subsequent reassignment to nil invalidates
        // it, so the later use fails again.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(s string?) string {
    var r string? = s
    if r == nil { r = mk() }
    r = nil
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
