// <copyright file="ScopeStatementTests.cs" company="GSharp">
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

/// Phase 5.7 / ADR-0022 — `scope { … }` structured concurrency.
/// Spawned `go` tasks lexically inside the body are awaited at
/// scope exit; the first failure is propagated (additional failures
/// attach as (cref:AggregateException) inner exceptions).
open class ScopeStatementTests {
    @Fact
    func Scope_Empty_Binds() {
        let result = Evaluate("scope { }\n")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Scope_WithGoStatements_Binds() {
        let source = `
func work() int32 { return 1 }

scope {
    go work()
    go work()
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Scope_WithSendInsideGo_Binds() {
        let source = `
let ch = chan[int32](1)

func send() int32 {
    ch <- 7
    return 0
}

scope {
    go send()
}
let v = <-ch
v
`
        let result = Evaluate(source)
        // GS0286 (TLS must be contiguous, ADR-0066 D5) fires as a warning
        // on this helper-between-TLS layout; the test exercises channel
        // semantics, not the layout warning, so filter it.
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id != "GS0286")
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Scope_NestedScopes_Bind() {
        let source = `
func work() int32 { return 1 }

scope {
    scope {
        go work()
    }
    go work()
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Scope_BodyWithNestedIf_LowersAndEvaluates() {
        // Regression: the Lowerer must recurse into the scope body when
        // flattening so emitted execution receives a flat statement list
        // (gotos for `if`) rather than a residual BoundIfStatement / nested
        // BoundBlockStatement.
        let source = `
let n = 3
scope {
    if n > 0 {
        let x = n + 1
    } else {
        let y = n - 1
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Scope_FailureInGoTask_Propagates() {
        // A scoped goroutine that throws should cause the enclosing
        // scope to surface the failure at exit, not silently swallow
        // it (which is the behaviour of free-standing `go`).
        let source = `
import System

func boom() int32 {
    let n = Int32.Parse("bad")
    return n
}

scope {
    go boom()
}
`
        // The scoped goroutine binds without any import (ADR-0174 removed the
        // gate), so the failure surfaces from the runtime, which is what this
        // test actually exercises.
        let result = EmittedOracle.Evaluate(source)
        // The failure may surface either as an unhandled runtime exception
        // or as a reported diagnostic — both are acceptable, what matters
        // is that the failure was not silently swallowed.
        Assert.True(
            result.UnhandledException != nil || !result.Diagnostics.IsEmpty,
            "Scope did not surface the failure from the scoped goroutine."
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            // ADR-0082 / issue #722: prepend the Go-extensions import so
            // existing scope-with-go tests continue to exercise scope
            // semantics rather than the import gate.
            let fullSource = source
            return EmittedOracle.Evaluate(fullSource)
        }
    }
}
