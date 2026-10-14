// <copyright file="SessionEngineChainedPerfTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System.Diagnostics
import Xunit

/// Issue #2101: chained REPL evaluation got dramatically slower as the number
/// of prior submissions grew — the evaluator engine's
/// `Compilation.ContinueWith(tree).Evaluate(variables)` per-submission
/// cost doubled roughly every additional cell (~O(2^n)), turning a 30-cell
/// session into a multi-minute CI hang. The evaluator-side chain guard
/// retired together with that engine (ADR-0156 Phase 3c, #3176); what remains
/// is the emitted engine's chain-scaling canary — a functional regression
/// guard with a generous timeout, not a tight perf assertion (those are flaky
/// in CI): it only asserts that 50 trivial submissions complete well within a
/// budget that super-linear per-cell behavior could never hit.
open class SessionEngineChainedPerfTests {
    /// The emitted counterpart (ADR-0156 Phase 3b.3): the interactive-default
    /// (cref:EmittedSessionEngine) has a different per-submission cost
    /// channel — a full in-memory emit, an ALC assembly load, and an import
    /// surface that grows with every prior submission — so it needs its own
    /// chain-scaling canary; the retired evaluator chain guard could not
    /// cover it (the engines shared no chain machinery). Survived Phase 3c
    /// as planned. Also asserts the
    /// chain actually carries state end to end (first and last variables
    /// readable from cell 51 — the REPL model the chain exists for).
    @Fact
    func Evaluate_FiftyChainedSubmissions_EmittedEngine_CompletesQuickly() {
        using let engine = EmittedSessionEngine()
        let sw = Stopwatch.StartNew()
        for var i = 0; i < 50; i++ {
            let cell = engine.Evaluate("var x$i = $i")
            Assert.False(cell.HasError, "submission $i unexpectedly failed: ${string.Join(", ", cell.Diagnostics)}")
        }
        sw.Stop()
        // The chain must still be live: a 51st cell reads globals declared by
        // the 1st and 50th submissions across their submission assemblies.
        let sum = engine.Evaluate("x0 + x49")
        Assert.False(sum.HasError, "state-carry submission unexpectedly failed: ${string.Join(", ", sum.Diagnostics)}")
        Assert.Equal(49, sum.Value)
        // Generous sanity ceiling for 50 emit+load cycles: linear-ish
        // per-cell cost lands well under this on any CI runner, while any
        // reintroduced super-linear growth (binding against the accumulated
        // import surface is the risk spot) blows past it long before cell 50.
        Assert.True(
            sw.Elapsed.TotalSeconds < float64(30.0),
            "50 chained emitted submissions took ${sw.Elapsed.TotalSeconds:F1}s — expected linear-ish scaling in the emitted submission chain."
        )
    }
}
