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
/// into a multi-minute CI hang. This is a functional regression guard with a
/// generous timeout, not a tight perf assertion (those are flaky in CI): it
/// only asserts that 50 trivial submissions complete well within a budget
/// that the old exponential behavior could never hit (it took ~80s for a
/// single submission around N=31 before the fix).
/// </summary>
public class SessionEngineChainedPerfTests
{
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
}
