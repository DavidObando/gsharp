// <copyright file="Issue3227TrailingCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #3227 — the emitted submission's trailing-expression capture must
/// recognize every statically capturable value-producing trailing form, not
/// just a plain trailing expression statement or variable declaration. The
/// retired evaluator's `LastValue` echoed the taken arm's tail value for
/// trailing `if`/`if let` statements, bare blocks, and switch
/// statements; the ADR-0156 Phase 2 `<Result>$` capture now
/// mirrors those shapes by storing every arm's tail value into the
/// synthesized global. Forms with no value on some path (an `if`
/// without `else`) or without a single static type across arms decline
/// the capture and echo nothing, exactly like other non-capturable values.
open class Issue3227TrailingCaptureTests {
    @Fact
    func TrailingIf_ThenBranchTaken_CapturesValue() {
        // The exact #3227 repro: with `if` a value-producing expression since
        // #669, the trailing if yields its taken branch's value.
        let result = EmittedOracle.Evaluate("let x string? = nil\nif x == nil { 1 } else { 0 }")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func TrailingIf_ElseBranchTaken_CapturesValue() {
        let result = EmittedOracle.Evaluate("let x string? = \"set\"\nif x == nil { 1 } else { 0 }")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func TrailingIfElseIfChain_CapturesTakenArmValue() {
        let result = EmittedOracle.Evaluate("let n = 2\nif n == 1 { 10 } else if n == 2 { 20 } else { 30 }")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(20, result.Value)
    }

    @Fact
    func TrailingNestedIf_CapturesInnerArmValue() {
        let result = EmittedOracle.Evaluate(`let a = true
let b = false
if a { if b { 1 } else { 2 } } else { 3 }`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func TrailingIf_ArmsEndingInDeclarations_CapturesDeclaredValue() {
        // The evaluator's LastValue treated a variable declaration's
        // initialized value as the statement's value; arm tails do the same.
        let result = EmittedOracle.Evaluate("let flag = true\nif flag { let y = 41 + 1 } else { let z = 0 }")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func TrailingIf_StringArms_CapturesReferenceTypedValue() {
        let result = EmittedOracle.Evaluate("let n = 7\nif n > 5 { \"big\" } else { \"small\" }")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("big", result.Value)
    }

    @Fact
    func TrailingBareBlock_CapturesTailValue() {
        let result = EmittedOracle.Evaluate(`let n = 40
{
    n + 2
}`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func TrailingSwitchStatement_WithDefault_CapturesTakenArmValue() {
        let result = EmittedOracle.Evaluate(`let n = 2
switch n {
case 1 { 10 }
case 2 { 20 }
default { 30 }
}`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(20, result.Value)
    }

    @Fact
    func TrailingSwitchStatement_DefaultArmTaken_CapturesValue() {
        let result = EmittedOracle.Evaluate(`let n = 9
switch n {
case 1 { 10 }
default { 30 }
}`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(30, result.Value)
    }

    @Fact
    func TrailingIfLetStatement_WithElse_CapturesTakenArmValue() {
        // ADR-0071 statement `if let` binds to a synthesized block ending in
        // the guard if — the capture recurses through the composition.
        let result = EmittedOracle.Evaluate("let x int32? = 21\nif let y = x { y * 2 } else { 0 }")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func TrailingIfLetStatement_ElseTaken_CapturesElseValue() {
        let result = EmittedOracle.Evaluate("let x int32? = nil\nif let y = x { y * 2 } else { -1 }")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-1, result.Value)
    }

    @Fact
    func TrailingIf_WithoutElse_DeclinesCapture() {
        // No value on the false path — not statically capturable; the
        // submission echoes nothing (Value null), like other non-capturable
        // trailing statements.
        let result = EmittedOracle.Evaluate("let flag = true\nif flag { 1 }")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.Value)
    }

    @Fact
    func TrailingIf_MixedArmTypes_DeclinesCapture() {
        // A statement if does not unify arm types; without one static type
        // there is no `<Result>$` field type, so the capture declines.
        let result = EmittedOracle.Evaluate("let flag = true\nif flag { 1 } else { \"other\" }")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.Value)
    }
}
