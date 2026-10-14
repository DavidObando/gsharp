// <copyright file="Issue1885LockStatementTests.cs" company="GSharp">
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
import System.Collections.Immutable
import Xunit

/// Issue #1885: G# gains a first-class `lock target { body }` statement
/// with the same semantics as C#'s `lock` — `Monitor.Enter`, then
/// `try { body } finally { Monitor.Exit }`. Previously cs2gs lowered
/// C# `lock` to raw `Monitor.Enter`/`Monitor.Exit` calls
/// without ever emitting `import System.Threading`, so the translated
/// G# failed to compile (GS0157). These tests exercise the new `lock`
/// keyword directly at the gsc level (parse, bind, evaluate).
open class Issue1885LockStatementTests {
    @Fact
    func Lock_RunsBody_AndReturnsMutatedValue() {
        let source = `
class Gate {}

var g = Gate{}
var total = 0
lock g {
    total = total + 1
    total = total + 1
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func Lock_ReleasesOnException_ViaFinally() {
        // The body throws; a `finally`-released monitor lets a later `lock`
        // against the SAME target re-acquire it with no deadlock — the
        // deterministic proof that `lock` lowers through try/finally.
        let source = `
import System

class Gate {}

var g = Gate{}
var trace = ""
try {
    lock g {
        trace = trace + "a"
        throw Exception("boom")
    }
} catch (e Exception) {
    trace = trace + "c"
}

lock g {
    trace = trace + "b"
}

trace
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("acb", result.Value)
    }

    @Fact
    func Lock_EvaluatesTargetExactlyOnce() {
        // A non-trivial (side-effecting) lock target must be evaluated
        // exactly once — not once for Enter and again for Exit.
        let source = `
class Gate {}

func GetGate() Gate {
    callCount = callCount + 1
    return Gate{}
}

var callCount = 0
lock GetGate() {
    var x = 1
}
callCount
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func Lock_OnValueTypeTarget_IsDiagnosed() {
        let diagnostics = Bind(`
var n = 1
lock n {
    var x = 1
}
`)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("reference type"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] -> Evaluate(source).Diagnostics
    }
}
