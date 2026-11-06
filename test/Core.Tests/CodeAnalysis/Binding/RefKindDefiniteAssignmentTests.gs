// <copyright file="RefKindDefiniteAssignmentTests.cs" company="GSharp">
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

/// ADR-0060 items #4 and #5 — definite-assignment analysis specialized
/// for ref-kind parameters: GS0238 for out-parameters not assigned on
/// every return path, GS0239 for variables passed by `ref` while still
/// unassigned at the call site.
open class RefKindDefiniteAssignmentTests {
    @Fact
    func OutParameter_AssignedInEveryTerminalSwitchArm_IsAccepted() {
        let result = EmittedOracle.Evaluate(`func tryParse(text string, out kind int32) bool {
    switch text {
        case "a" {
            kind = 1
            return true
        }
        default {
            kind = 0
            return false
        }
    }
}

var kind = -1
tryParse("a", out kind)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func OutParameterNotAssigned_ReportsGS0238() {
        const Source = `package OutDA1

func bad(out a int32) {
    return
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedOnAllPaths_NoDiagnostic() {
        const Source = `package OutDA2

func ok(out a int32, cond bool) {
    if cond {
        a = 1
    } else {
        a = 2
    }
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedOnOnlyOneBranch_ReportsGS0238() {
        const Source = `package OutDA3

func bad(out a int32, cond bool) {
    if cond {
        a = 1
    }
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedUnconditionally_NoDiagnostic() {
        const Source = `package OutDA4

func ok(out a int32) {
    a = 99
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func RefArgumentUnassigned_ReportsGS0239() {
        const Source = `package RefDA1

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x int32
    bump(&x)
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0239")
    }

    @Fact
    func RefArgumentAssigned_NoDiagnostic() {
        const Source = `package RefDA2

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x = 0
    bump(&x)
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0239")
    }

    @Fact
    func OutArgumentAssignsForRef_NoDiagnostic() {
        const Source = `package RefDA3

func produce(out x int32) {
    x = 42
}

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x int32
    produce(&x)
    bump(&x)
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0239")
    }

    // Issue #1642 — the definite-assignment CFG previously treated
    // try/select/scope/fixed bodies as opaque, so assignments inside them
    // were invisible and produced false GS0238/GS0239 errors on valid code.
    @Fact
    func OutParameterAssignedInTryAndFinally_NoDiagnostic() {
        // Exact repro from issue #1642.
        const Source = `package TryDA1

func ok(out a int32) {
    try { a = 1 } finally { }
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedOnlyInFinally_NoDiagnostic() {
        // `finally` always runs, so an assignment made only there is
        // guaranteed regardless of what happens in the try body.
        const Source = `package TryDA2

func ok(out a int32) {
    try { } finally { a = 1 }
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedInTryBodyOnly_CatchDoesNotAssign_ReportsGS0238() {
        // An exception could skip the try-body assignment, and the catch
        // clause (which can complete normally without assigning `a`)
        // doesn't guarantee it either — must still be rejected.
        const Source = `package TryDA3

import System

func bad(out a int32) {
    try {
        a = 1
    } catch (e Exception) {
    }
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedInTryAndEveryCatch_NoDiagnostic() {
        const Source = `package TryDA4

import System

func ok(out a int32) {
    try {
        a = 1
    } catch (e Exception) {
        a = 2
    }
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedInScopeBody_NoDiagnostic() {
        const Source = `package ScopeDA1

func ok(out a int32) {
    scope {
        a = 1
    }
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedInFixedBody_NoDiagnostic() {
        const Source = `package FixedDA1

unsafe func ok(out a int32, arr []int32) {
    fixed p *int32 = arr {
        a = 1
    }
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func OutParameterAssignedInEveryExhaustiveSelectArm_NoDiagnostic() {
        // `select` always blocks until exactly one arm runs its body, so an
        // assignment made on every arm is guaranteed afterward.
        const Source = `package SelectDA1

func ok(out a int32) {
    let ch = chan[int32](1)
    ch <- 1
    select {
    case let v = <-ch {
        a = v
    }
    default {
        a = 0
    }
    }
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func IndirectAssignmentThroughPointer_CountsAsAssignment() {
        // `*p = expr` (BoundIndirectAssignmentExpression) through a pointer
        // known to alias the out parameter must count as an assignment.
        const Source = `package IndirectDA1

unsafe func ok(out a int32) {
    var p *int32 = &a
    *p = 5
}
`
        let result = Compile(Source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ReturnInsideTryWithoutAssigningOutParameter_ReportsGS0238() {
        // A `return` nested inside a try body still leaves the function; the
        // out parameter must be assigned before it, same as a top-level return.
        const Source = `package TryDA5

func bad(out a int32, cond bool) {
    try {
        if cond {
            return
        }

        a = 1
    } finally {
    }
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    // Issue #4417 — reading an unassigned `out` parameter on any value-read
    // path (call argument, explicit/implicit `in` argument, operator operand,
    // member/index receiver, compound assignment, closure capture, or after a
    // partial branch assignment) reports GS0239.
    @Theory
    @InlineData(`func val(v int32) int32 -> v
func bad(out x int32) int32 {
    let y = val(x)
    x = 1
    return y
}`)
    @InlineData(`func takeIn(in v int32) int32 -> v
func bad(out x int32) int32 {
    let y = takeIn(in x)
    x = 1
    return y
}`)
    @InlineData(`func takeIn(in v int32) int32 -> v
func bad(out x int32) int32 {
    let y = takeIn(x)
    x = 1
    return y
}`)
    @InlineData(`func bad(out x int32) int32 {
    let y = x + 1
    x = 1
    return y
}`)
    @InlineData(`func bad(out x int32) {
    x += 1
}`)
    @InlineData(`func bad(out x string) int32 {
    let n = x.Length
    x = "ok"
    return n
}`)
    @InlineData(`func bad(out x []int32) {
    x[0] = 1
    x = []int32{1}
}`)
    @InlineData(`func bad(out x int32, cond bool) int32 {
    if cond {
        x = 1
    }
    let y = x
    x = 2
    return y
}`)
    @InlineData(`func bad(out x int32) int32 {
    let f = () -> x
    x = 1
    return f()
}`)
    @InlineData(`class Box {
    var f int32
}
func bad(out x Box) {
    x.f = 1
    x = Box()
}`)
    @InlineData(`func put(out a int32, b int32) {
    a = b
}
func bad(out x int32) {
    put(&x, x)
}`)
    @InlineData(`unsafe func bad(out x []int32) {
    let pointers = []*int32{&x[0]}
    x = []int32{1}
}`)
    @InlineData(`func fill(out v int32) int32 {
    v = 1
    return v
}
unsafe func bad(values []int32, out x int32) {
    *(&values[x]) = fill(out x)
}`)
    @InlineData(`struct Pair {
    var f int32
}
func takeRef(ref v int32) {}
func bad(out x Pair) {
    takeRef(&x.f)
    x = Pair{f: 1}
}`)
    @InlineData(`import System.Numerics
func takeRef(ref v float32) {}
func bad(out x Vector2) {
    takeRef(&x.X)
    x = Vector2(1.0f, 2.0f)
}`)
    func OutParameterReadBeforeAssignment_ReportsGS0239(body string) {
        let result = Compile("package OutReadDA\n\n" + body + "\n")
        let diag = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0239")
        Assert.Contains("'x'", diag.Message)
        Assert.NotEqual(default(TextLocation), diag.Location)
        Assert.True(diag.Location.Span.Length > 0)
    }

    @Fact
    func OutParameterReadAfterAssignmentOnAllPaths_NoDiagnostic() {
        const Source = `package OutReadOk

import System.Numerics

struct Pair {
    var f int32
}

func takeIn(in v int32) int32 -> v
func fill(out v int32) int32 {
    v = 3
    return v
}
func fillFloat(out v float32) {
    v = 4.0f
}
func combine(a int32, b int32) int32 -> a + b

unsafe func ok(out x int32, out s Pair, out vec Vector2, cond bool) int32 {
    var other = 0
    let _ = fill(out (cond ? x : other))
    let pField *int32 = &s.f
    *pField = 1
    let _ = fill(out s.f)
    fillFloat(out vec.X)
    s.f = 1
    s = Pair{f: 2}
    vec.X = 1.0f
    vec = Vector2(2.0f, 3.0f)
    if cond {
        x = combine(fill(out x), x)
    } else {
        x = 20
    }
    x += 5
    return takeIn(x)
}
`
        let result = Compile(Source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Compile(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
