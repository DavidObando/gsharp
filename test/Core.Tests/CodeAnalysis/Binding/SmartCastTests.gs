// <copyright file="SmartCastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Phase 3.C.4 — smart casts after a nil-comparison guard. Minimal version:
/// only single-variable `x != nil` / `x == nil` guards on the
/// condition of an `if` trigger narrowing inside the matching arm.
open class SmartCastTests {
    @Fact
    func NotEqualsNil_NarrowsInThenArm() {
        // Without narrowing, `var y int = x` would diagnose because x is int?.
        let source = `
var x int32? = 5
var y int32 = 0
if x != nil {
    y = x
}
y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func EqualsNil_DoesNotNarrowThenArm() {
        // Narrowing must not happen in the wrong arm.
        let source = `
var x int32? = 5
var y int32 = 0
if x == nil {
    y = x
}
y
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func NilLiteralOnLeft_AlsoNarrows() {
        let source = `
var x int32? = 7
var y int32 = 0
if nil != x {
    y = x
}
y
`
        // Issue #3217: the binder canonicalizes `nil != x` to `x != nil`, so
        // the emitted nil-comparison machinery owns the node and the IL
        // verifies; the nil-on-left form previously fell through to a raw
        // `ceq` and threw InvalidProgramException at runtime.
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NarrowingDoesNotLeakAfterIf() {
        // Outside the guarded block, x is still nullable.
        let source = `
var x int32? = 1
if x != nil {
    var t int32 = x
}
var z int32 = x
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Mutation_InvalidatesNarrowing() {
        // After `x = nil` inside the then-arm, the narrowing must be
        // dropped so the next read sees the declared nullable type and the
        // unsafe `var t int = x` is rejected.
        let source = `
var x int32? = 5
if x != nil {
    x = nil
    var t int32 = x
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Narrowing_AvailableBeforeMutation() {
        // The narrowing should still be in effect for statements that
        // precede the invalidating assignment.
        let source = `
var x int32? = 5
var y int32 = 0
if x != nil {
    y = x
    x = nil
}
y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
