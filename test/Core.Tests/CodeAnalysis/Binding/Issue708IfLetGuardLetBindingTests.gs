// <copyright file="Issue708IfLetGuardLetBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #708 / ADR-0071 — binder coverage for `if let` and
/// `guard let` nullable-binding statements: diagnostic surface,
/// scoping rules, and composition with the ADR-0069 flow-narrowing
/// machinery.
open class Issue708IfLetGuardLetBindingTests {
    @Fact
    func IfLet_NonNullableRhs_Diagnoses_GS0296() {
        let result = Evaluate(`
func Run() {
    var s = "hi"
    if let v = s {
        var x = v
    }
}
Run()
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0296")
    }

    @Fact
    func IfLet_NullableRhs_NarrowsBindingInThenBranch() {
        // Inside the then-branch, `v` is narrowed to `string` and may be
        // passed to a `string`-typed parameter.
        let result = Evaluate(`
func Take(s string) int32 { return s.Length }
func Run(s string?) int32 {
    if let v = s {
        return Take(v)
    }
    return 0
}
Run("hi")
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func IfLet_BindingNotVisibleInElseBranch() {
        let result = Evaluate(`
func Run(s string?) int32 {
    if let v = s {
        return v.Length
    } else {
        return v.Length
    }
}
Run("hi")
`)
        // `v` is not visible in the else branch.
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0001" || d.Message.Contains("v"))
    }

    @Fact
    func IfLet_MultipleBindings_AllNarrowInThenBranch() {
        let result = Evaluate(`
func Take(a string, b string) int32 { return a.Length + b.Length }
func Run(a string?, b string?) int32 {
    if let x = a, let y = b {
        return Take(x, y)
    }
    return 0
}
Run("a", "b")
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GuardLet_ElseWithoutExit_Diagnoses_GS0297() {
        let result = Evaluate(`
func Run(s string?) {
    guard let v = s else {
        var x = 1
    }
    var y = v
}
Run("hi")
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0297")
    }

    @Fact
    func GuardLet_ElseWithReturn_IsAccepted() {
        let result = Evaluate(`
func Run(s string?) int32 {
    guard let v = s else {
        return 0
    }
    return v.Length
}
Run("hi")
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GuardLet_ElseWithThrow_IsAccepted() {
        // Void-returning function: the throw is recognised as an
        // unconditional exit (GS0297 must not fire). The
        // ControlFlowGraph all-paths-return analysis is not consulted
        // for void returns, so this exercises the GS0297 exit-set
        // independently of the "must return a value" check.
        let result = Evaluate(`
import System
func Run(s string?) {
    guard let v = s else {
        throw Exception(message: "boom")
    }
    var x = v
}
Run("hi")
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0297")
    }

    @Fact
    func GuardLet_NonNullableRhs_Diagnoses_GS0296() {
        let result = Evaluate(`
func Run() int32 {
    var s = "hi"
    guard let v = s else {
        return 0
    }
    return v.Length
}
Run()
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0296")
    }

    @Fact
    func GuardLet_NarrowsBindingForRestOfBlock() {
        // After a successful `guard let v = s`, `v` is in scope for the
        // remainder of the block and typed as the underlying non-null
        // type.
        let result = Evaluate(`
func Take(s string) int32 { return s.Length }
func Run(s string?) int32 {
    guard let v = s else {
        return 0
    }
    return Take(v)
}
Run("hi")
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GuardLet_MultipleBindings_AllNarrow() {
        let result = Evaluate(`
func Take(a string, b string) int32 { return a.Length + b.Length }
func Run(a string?, b string?) int32 {
    guard let x = a, let y = b else {
        return 0
    }
    return Take(x, y)
}
Run("a", "b")
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func IfLet_ComposesWithDownstreamSmartCast() {
        // Inside the then-branch, `v` has been narrowed from `string?`
        // to `string`. A subsequent `&& v.Length > 0` short-circuit
        // should accept the member access without a further guard.
        let result = Evaluate(`
func Run(s string?) int32 {
    if let v = s {
        if v.Length > 0 {
            return v.Length
        }
    }
    return 0
}
Run("hi")
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GuardLet_SingleBinding_ElseDiagnosticReportedExactlyOnce() {
        // Issue #1637: the else block used to be bound once as a
        // validity probe and once more per binding arm, so a single
        // binding produced the same diagnostic twice.
        let result = Evaluate(`
func Run(s string?) int32 {
    guard let v = s else {
        var w = "hi"
        guard let n = w else {
            return 0
        }
        return n.Length
    }
    return v.Length
}
Run("hi")
`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0296")
    }

    @Fact
    func GuardLet_MultipleBindings_ElseDiagnosticReportedExactlyOnce() {
        // Issue #1637: with N binding arms the else block used to be
        // re-bound N+1 times, reporting every diagnostic inside it
        // N+1 times instead of once.
        let result = Evaluate(`
func Run(a string?, b string?) int32 {
    guard let x = a, let y = b else {
        var w = "hi"
        guard let n = w else {
            return 0
        }
        return n.Length
    }
    return x.Length + y.Length
}
Run("a", "b")
`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0296")
    }

    @Fact
    func GuardLet_MultipleBindings_ElseWithoutExit_DiagnosesGS0297ExactlyOnce() {
        let result = Evaluate(`
func Run(a string?, b string?) {
    guard let x = a, let y = b else {
        var z = 1
    }
    var w = x
    var q = y
}
Run("a", "b")
`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0297")
    }

    @Fact
    func GuardLet_LaterArmBadInitializer_ArmDiagnosticSurvivesExactlyOnce() {
        // Arm 2's rhs is non-nullable (its own GS0296). Arm 1 succeeds and
        // binds the else block; per #1637 the arm-2-specific diagnostic
        // must still surface exactly once, not swallowed by the else's
        // per-arm TruncateTo.
        let result = Evaluate(`
func Run(a string?) int32 {
    guard let x = a, let y = "hi" else {
        return 0
    }
    return x.Length + y.Length
}
Run("a")
`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0296")
    }

    @Fact
    func GuardLet_AllArmsFail_ElseStillBoundOnceForDiagnostics() {
        // Issue #1637 follow-up: if every binding arm fails (non-nullable
        // rhs on both), the arm loop never binds the else block. The
        // fallback bind must still surface GS0297 and the else's own
        // internal diagnostic exactly once.
        let result = Evaluate(`
func Run() {
    guard let x = "a", let y = "b" else {
        var z = 1
    }
    var w = 1
}
Run()
`)
        Assert.Equal(2, result.Diagnostics.Count((d Diagnostic) -> d.Id == "GS0296"))
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0297")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
