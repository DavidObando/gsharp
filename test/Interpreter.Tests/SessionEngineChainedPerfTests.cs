// <copyright file="SessionEngineChainedPerfTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2101: chained REPL evaluation via
/// <c>Compilation.ContinueWith(tree).Evaluate(variables)</c> got dramatically
/// slower as the number of prior submissions grew — the per-submission cost
/// doubled roughly every additional cell (~O(2^n)), turning a 30-cell session
/// into a multi-minute CI hang. These are functional regression guards with
/// generous timeouts, not tight perf assertions (those are flaky in CI): each
/// only asserts that 50 trivial submissions complete well within a budget
/// that exponential per-cell behavior could never hit (it took ~80s for a
/// single submission around N=31 before the #2101 fix).
/// </summary>
public class SessionEngineChainedPerfTests
{
    /// <summary>
    /// EVALUATOR-MACHINERY PIN (ADR-0156 Phase 3b.3; retire with the
    /// evaluator engine in Phase 3c, #3176): only the tree-walking
    /// <see cref="SessionEngine"/> drives the
    /// <c>ContinueWith</c> → <c>Previous</c> bound-scope chain whose binding
    /// cost #2101 fixed — the emitted engine builds an independent
    /// compilation per submission via <c>SubmissionImports</c> and never
    /// touches that path. This guard pins the deprecated
    /// <c>--engine evaluator</c> escape hatch's chain scaling until 3c
    /// deletes the engine (and this test with it).
    /// </summary>
    [Fact]
    public void Evaluate_FiftyChainedSubmissions_CompletesQuickly()
    {
        var engine = new SessionEngine();
        var sw = Stopwatch.StartNew();

        for (var i = 0; i < 50; i++)
        {
            var cell = engine.Evaluate($"var x{i} = {i}");
            Assert.False(cell.HasError, $"submission {i} unexpectedly failed: {string.Join(", ", cell.Diagnostics)}");
        }

        sw.Stop();

        // Generous sanity ceiling: linear-ish binding of 50 trivial
        // submissions should take well under a second on any CI runner.
        // Before the fix, this loop took tens of seconds by submission ~30
        // and would not have finished within any reasonable multiple of this
        // budget by submission 50.
        Assert.True(
            sw.Elapsed.TotalSeconds < 10,
            $"50 chained submissions took {sw.Elapsed.TotalSeconds:F1}s — expected linear-ish scaling, not the pre-fix O(2^n) blowup.");
    }

    /// <summary>
    /// The emitted counterpart (ADR-0156 Phase 3b.3): the interactive-default
    /// <see cref="EmittedSessionEngine"/> has a different per-submission cost
    /// channel — a full in-memory emit, an ALC assembly load, and an import
    /// surface that grows with every prior submission — so it needs its own
    /// chain-scaling canary; the evaluator guard above cannot cover it (the
    /// engines share no chain machinery). Survives Phase 3c. Also asserts the
    /// chain actually carries state end to end (first and last variables
    /// readable from cell 51 — the REPL model the chain exists for).
    /// </summary>
    [Fact]
    public void Evaluate_FiftyChainedSubmissions_EmittedEngine_CompletesQuickly()
    {
        using var engine = new EmittedSessionEngine();
        var sw = Stopwatch.StartNew();

        for (var i = 0; i < 50; i++)
        {
            var cell = engine.Evaluate($"var x{i} = {i}");
            Assert.False(cell.HasError, $"submission {i} unexpectedly failed: {string.Join(", ", cell.Diagnostics)}");
        }

        sw.Stop();

        // The chain must still be live: a 51st cell reads globals declared by
        // the 1st and 50th submissions across their submission assemblies.
        var sum = engine.Evaluate("x0 + x49");
        Assert.False(sum.HasError, $"state-carry submission unexpectedly failed: {string.Join(", ", sum.Diagnostics)}");
        Assert.Equal(49, sum.Value);

        // Generous sanity ceiling for 50 emit+load cycles: linear-ish
        // per-cell cost lands well under this on any CI runner, while any
        // reintroduced super-linear growth (binding against the accumulated
        // import surface is the risk spot) blows past it long before cell 50.
        Assert.True(
            sw.Elapsed.TotalSeconds < 30,
            $"50 chained emitted submissions took {sw.Elapsed.TotalSeconds:F1}s — expected linear-ish scaling in the emitted submission chain.");
    }
}
