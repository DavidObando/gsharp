// <copyright file="Issue3304GoVoidOperandTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #3304: `go f(args)` must accept a void-returning call operand.
/// The spawned call's result is discarded (ADR-0022), so a `void` target is
/// the most natural goroutine shape — pre-fix the binder bound the operand
/// with `canBeVoid: false` and reported GS0124 ("Expression must have a
/// value."), forcing `return 0` boilerplate onto every goroutine body in the
/// corpus. Found by the ADR-0158 feasibility spike.
open class Issue3304GoVoidOperandTests {
    @Fact
    func Go_OnVoidFunctionCall_BindsAndRuns() {
        // Exact repro from #3304: void top-level function launched as a
        // goroutine, observable through a buffered channel rendezvous.
        let source = `var done = chan[int32](1)

func poke() {
    done <- 42
}

func run() int32 {
    go poke()
    return <-done
}

run()`
        let result = Evaluate(source)
        AssertNoRealDiagnostics(result)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Go_OnVoidInstanceMethodCall_BindsAndRuns() {
        // `go b.Poke(...)` — void user-instance-call operand shape.
        let source = `class Box {
    func Poke(ch chan[int32]) {
        ch <- 7
    }
}

func run() int32 {
    let done = chan[int32](1)
    let b = Box{}
    go b.Poke(done)
    return <-done
}

run()`
        let result = Evaluate(source)
        AssertNoRealDiagnostics(result)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Go_OnVoidFunctionValueCall_CapturingLocal_BindsAndRuns() {
        // Void indirect-call operand: a function literal capturing an
        // enclosing local, launched by name (BoundIndirectCallExpression).
        let source = `let ch = chan[int32](1)

func run() int32 {
    let x = 10
    let send = func() {
        ch <- x
    }
    go send()
    return <-ch
}

run()`
        let result = Evaluate(source)
        AssertNoRealDiagnostics(result)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func Go_InScope_OnVoidCall_JoinsAtScopeExit() {
        // Structured concurrency: a scoped void goroutine must be joined at
        // scope exit, so the buffered send is guaranteed complete before the
        // receive that follows the scope.
        let source = `let done = chan[int32](1)

func poke() {
    done <- 21
}

func run() int32 {
    scope {
        go poke()
    }
    return <-done
}

run()`
        let result = Evaluate(source)
        AssertNoRealDiagnostics(result)
        Assert.Equal(21, result.Value)
    }

    @Fact
    func Go_OnValueReturningCall_StillBinds_ResultDiscarded() {
        // Regression pin: the pre-existing value-returning operand keeps
        // working, and its result is discarded rather than leaking into the
        // caller (see also Issue1651GoroutineIsolationEmittedOracleTests).
        let source = `let started = chan[int32](1)

func spawnee() int32 {
    started <- 1
    return 999
}

func run() int32 {
    go spawnee()
    let signal = <-started
    return signal + 2
}

run()`
        let result = Evaluate(source)
        AssertNoRealDiagnostics(result)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Go_OnAsyncNoResultFunctionCall_StillBindsViaTaskShape() {
        // Async interplay pin (unchanged by #3304): a call to an async
        // no-result function is bound with a Task return type at the call
        // site (OverloadResolver wraps via WrapAsTask), so it never hits the
        // void-operand path — the goroutine takes the Func<Task> thunk and
        // is a properly awaited spawn, before and after this fix.
        let source = `import System.Threading.Tasks

async func work() {
    await Task.Delay(1)
}

go work()`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Go_OnNonCallExpression_StillDiagnosesGS0137() {
        // Pin: only the void restriction is lifted — a non-call operand is
        // still rejected with GS0137.
        let source = "let x = 42\ngo x"
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0137")
    }

    @Fact
    func Go_OnBareFunctionLiteral_StillDiagnosesGS0137() {
        // Pin: a bare (uninvoked) function literal is not a call; Go itself
        // requires `go func() { ... }()` — the literal alone stays rejected.
        let source = "go func() { }"
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0137")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            // ADR-0082 / issue #722: `go` is gated behind this import.
            let fullSource = source
            return EmittedOracle.Evaluate(fullSource)
        }

        /// Fixtures declare a top-level channel ahead of the functions that use
        /// it and place the driving call after them; GS0286 (ADR-0066 D5) flags
        /// that split-TLS layout as a warning. Filter it the same way
        /// `Issue1651GoroutineIsolationEmittedOracleTests` does.
        private func AssertNoRealDiagnostics(result EmittedOracleResult) {
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id != "GS0286")
        }
    }
}
