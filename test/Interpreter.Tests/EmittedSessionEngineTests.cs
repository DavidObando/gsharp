// <copyright file="EmittedSessionEngineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0156 Phase 2: the emitted submission-chaining REPL engine. Each test
/// pins one of the interactive semantics the migration must preserve (or
/// deliberately changes — see the deinit test, where real emitted code now
/// runs deinitializers interactively and GS0510 no longer fires).
/// </summary>
public sealed class EmittedSessionEngineTests : IDisposable
{
    private readonly EmittedSessionEngine engine = new();

    public void Dispose() => engine.Dispose();

    [Fact]
    public void CrossSubmissionVariableReadAndWrite()
    {
        Assert.False(engine.Evaluate("var counter = 10").HasError);

        var read = engine.Evaluate("counter + 5");
        Assert.False(read.HasError);
        Assert.Equal(15, read.Value);

        var write = engine.Evaluate("counter = 40");
        Assert.False(write.HasError);

        var compound = engine.Evaluate("counter += 2");
        Assert.False(compound.HasError);

        var readBack = engine.Evaluate("counter");
        Assert.False(readBack.HasError);
        Assert.Equal(42, readBack.Value);
    }

    [Fact]
    public void CrossSubmissionFunctionCall()
    {
        Assert.False(engine.Evaluate("func addOne(n int) int {\n    return n + 1\n}").HasError);

        var call = engine.Evaluate("addOne(41)");
        Assert.False(call.HasError);
        Assert.Equal(42, call.Value);
    }

    [Fact]
    public void CrossSubmissionStructConstructionAndMethodCall()
    {
        Assert.False(engine.Evaluate("""
            struct Point {
                var X int
                var Y int
                func Sum() int {
                    return X + Y
                }
            }
            """).HasError);

        var use = engine.Evaluate("var p = Point{X: 3, Y: 4}\np.Sum()");
        Assert.False(use.HasError);
        Assert.Equal(7, use.Value);

        // Member access on the stored instance from yet another submission.
        var later = engine.Evaluate("p.Sum()");
        Assert.False(later.HasError);
        Assert.Equal(7, later.Value);
    }

    [Fact]
    public void CrossSubmissionClassInstanceMutation()
    {
        Assert.False(engine.Evaluate("""
            class Counter {
                var N int
                func Bump() {
                    N = N + 1
                }
            }
            var c = Counter{N: 5}
            """).HasError);

        var first = engine.Evaluate("c.Bump()\nc.N");
        Assert.False(first.HasError);
        Assert.Equal(6, first.Value);

        var second = engine.Evaluate("c.Bump()\nc.N");
        Assert.False(second.HasError);
        Assert.Equal(7, second.Value);
    }

    [Fact]
    public void ClosureCapturingHoistedGlobalSharesTheCell()
    {
        Assert.False(engine.Evaluate("var total = 0").HasError);
        Assert.False(engine.Evaluate("""
            let bump = func() int {
                total = total + 10
                return total
            }
            """).HasError);

        var first = engine.Evaluate("bump()");
        Assert.False(first.HasError);
        Assert.Equal(10, first.Value);

        var second = engine.Evaluate("bump()");
        Assert.False(second.HasError);
        Assert.Equal(20, second.Value);

        var direct = engine.Evaluate("total");
        Assert.False(direct.HasError);
        Assert.Equal(20, direct.Value);
    }

    [Fact]
    public void RedefiningVariableNewestWinsEvenAcrossTypes()
    {
        Assert.False(engine.Evaluate("var x = 1").HasError);
        Assert.False(engine.Evaluate("var x = \"text\"").HasError);

        var read = engine.Evaluate("x");
        Assert.False(read.HasError);
        Assert.Equal("text", read.Value);
    }

    [Fact]
    public void RedefiningFunctionNewestWins()
    {
        Assert.False(engine.Evaluate("func f() int {\n    return 1\n}").HasError);
        Assert.False(engine.Evaluate("func f() int {\n    return 2\n}").HasError);

        var call = engine.Evaluate("f()");
        Assert.False(call.HasError);
        Assert.Equal(2, call.Value);
    }

    [Fact]
    public void RedefiningStructNewestWinsAndOldInstancesKeepOldType()
    {
        Assert.False(engine.Evaluate("""
            struct S {
                var V int
                func Tag() int {
                    return V
                }
            }
            var old = S{V: 7}
            """).HasError);
        Assert.False(engine.Evaluate("""
            struct S {
                var V int
                func Tag() int {
                    return V * 100
                }
            }
            """).HasError);

        var fresh = engine.Evaluate("var neu = S{V: 2}\nneu.Tag()");
        Assert.False(fresh.HasError);
        Assert.Equal(200, fresh.Value);

        // The instance created before the redefinition keeps its original
        // type and behavior — exactly like Roslyn interactive.
        var stale = engine.Evaluate("old.Tag()");
        Assert.False(stale.HasError);
        Assert.Equal(7, stale.Value);
    }

    [Fact]
    public void LetGlobalIsReadOnlyAcrossSubmissions()
    {
        Assert.False(engine.Evaluate("let frozen = 5").HasError);

        var write = engine.Evaluate("frozen = 6");
        Assert.True(write.HasError);
        Assert.Contains(write.Diagnostics, d => d.Id == "GS0127");

        var read = engine.Evaluate("frozen");
        Assert.False(read.HasError);
        Assert.Equal(5, read.Value);
    }

    [Fact]
    public void FailedCompilationDoesNotPoisonTheChain()
    {
        Assert.False(engine.Evaluate("var ok = 1").HasError);

        var bad = engine.Evaluate("definitely_undefined + 1");
        Assert.True(bad.HasError);

        var next = engine.Evaluate("ok + 1");
        Assert.False(next.HasError);
        Assert.Equal(2, next.Value);
    }

    [Fact]
    public void FailedSubmissionDeclarationsAreDiscarded()
    {
        var bad = engine.Evaluate("var kept = 1\nundefined_here");
        Assert.True(bad.HasError);

        var read = engine.Evaluate("kept");
        Assert.True(read.HasError);
    }

    [Fact]
    public void RuntimeExceptionKeepsChainAtLastGoodSubmissionButPartialEffectsPersist()
    {
        Assert.False(engine.Evaluate("var state = \"initial\"").HasError);

        // The submission mutates earlier state, then throws: the mutation
        // persists (it already executed) but the submission's own
        // declarations are discarded — matching the evaluator engine.
        var throwing = engine.Evaluate("""
            state = "mutated"
            var localOnly = 3
            let arr = [2]int{1, 2}
            arr[9]
            """);
        Assert.True(throwing.HasError);
        Assert.Contains(throwing.Diagnostics, d => d.Id == "GSI002");

        var state = engine.Evaluate("state");
        Assert.False(state.HasError);
        Assert.Equal("mutated", state.Value);

        var dropped = engine.Evaluate("localOnly");
        Assert.True(dropped.HasError);
    }

    [Fact]
    public void TrailingExpressionValueIsEchoed()
    {
        var cell = engine.Evaluate("2 * 21");
        Assert.False(cell.HasError);
        Assert.Equal(42, cell.Value);
    }

    [Fact]
    public void TrailingVariableDeclarationEchoesItsValue()
    {
        var cell = engine.Evaluate("var q = 5 * 5");
        Assert.False(cell.HasError);
        Assert.Equal(25, cell.Value);
    }

    [Fact]
    public void VoidCallHasNoEcho()
    {
        var cell = new EmittedSessionEngine { CaptureConsole = true }.Evaluate("Console.WriteLine(\"hi\")");
        Assert.False(cell.HasError);
        Assert.Null(cell.Value);
        Assert.Equal("hi\n", cell.Output);
    }

    [Fact]
    public void DeclarationOnlySubmissionHasNoEchoAndNoError()
    {
        var cell = engine.Evaluate("func noop() {\n}");
        Assert.False(cell.HasError);
        Assert.Null(cell.Value);
    }

    [Fact]
    public void ImportsPersistAcrossSubmissions()
    {
        Assert.False(engine.Evaluate("import System.Text").HasError);

        var use = engine.Evaluate("""
            var sb = StringBuilder()
            sb.Append("ab")
            sb.ToString()
            """);
        Assert.False(use.HasError);
        Assert.Equal("ab", use.Value);
    }

    [Fact]
    public void AsyncSubmissionAwaitsToCompletionAndEchoes()
    {
        Assert.False(engine.Evaluate("import System.Threading.Tasks").HasError);

        var cell = engine.Evaluate("""
            let t = Task.Run(func() int { return 40 + 2 })
            await t
            """);
        Assert.False(cell.HasError);
        Assert.Equal(42, cell.Value);
    }

    [Fact]
    public void ConsoleOutputIsCapturedPerCell()
    {
        engine.CaptureConsole = true;
        var cell = engine.Evaluate("Console.WriteLine(\"line-1\")\nConsole.WriteLine(\"line-2\")");
        Assert.False(cell.HasError);
        Assert.Equal("line-1\nline-2\n", cell.Output);
    }

    [Fact]
    public void ResetStartsAFreshChain()
    {
        Assert.False(engine.Evaluate("var x = 1").HasError);
        Assert.False(engine.Evaluate("func g() int {\n    return 3\n}").HasError);

        engine.Reset();
        Assert.Empty(engine.Cells);
        Assert.True(engine.Snapshot().IsEmpty);

        Assert.True(engine.Evaluate("x").HasError);
        Assert.True(engine.Evaluate("g()").HasError);

        // And the fresh chain accepts new definitions under the old names.
        Assert.False(engine.Evaluate("var x = 9").HasError);
        var read = engine.Evaluate("x");
        Assert.False(read.HasError);
        Assert.Equal(9, read.Value);
    }

    /// <summary>
    /// ADR-0156 Phase 2 deliberate semantic change: interactive submissions
    /// run real emitted code, so a class deinitializer executes as a genuine
    /// CLR finalizer when a collection is forced — and the GS0510 interpreter
    /// boundary warning (pinned for the evaluator engine by
    /// <c>Issue2988DeinitInterpreterTests.ForcedCollectionSkipsDeinitializerAndWarnsOnce</c>)
    /// no longer fires, matching Phase 1's script-mode behavior.
    /// </summary>
    [Fact]
    public void InteractiveDeinitializerRunsWithoutBoundaryWarning()
    {
        engine.CaptureConsole = true;
        var cell = engine.Evaluate("""
            class Resource {
                deinit {
                    Console.WriteLine("deinit-ran-22")
                }
            }

            func Allocate() {
                var resource = Resource()
                GC.KeepAlive(resource)
            }

            Allocate()
            GC.Collect()
            GC.WaitForPendingFinalizers()
            Console.WriteLine("body-33")
            """);

        Assert.False(cell.HasError);
        Assert.DoesNotContain(cell.Diagnostics, d => d.Id == "GS0510");
        Assert.Contains("deinit-ran-22", cell.Output, StringComparison.Ordinal);
        Assert.Contains("body-33", cell.Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EvaluateAsyncCancelledBeforeCommitDoesNotAppendCellOrMutateState()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => engine.EvaluateAsync("let x = 1", cts.Token));

        Assert.Empty(engine.Cells);

        var next = engine.Evaluate("x");
        Assert.True(next.HasError);
    }

    [Fact]
    public async Task EvaluateAsyncNotCancelledCommitsCellNormally()
    {
        var cell = await engine.EvaluateAsync("1 + 1", CancellationToken.None);

        Assert.Single(engine.Cells);
        Assert.False(cell.HasError);
        Assert.Equal(2, cell.Value);
    }

    /// <summary>
    /// Issue #3184: a prior cell's top-level function referenced as a value
    /// (`let g = addOne`) binds to a delegate over the emitted static method,
    /// exactly like the same-cell method-group-to-function-value conversion.
    /// </summary>
    [Fact]
    public void PriorCellFunctionAsValueBindsAndInvokes()
    {
        Assert.False(engine.Evaluate("func addOne(n int) int {\n    return n + 1\n}").HasError);

        var let = engine.Evaluate("let g = addOne");
        Assert.False(let.HasError);

        var call = engine.Evaluate("g(41)");
        Assert.False(call.HasError);
        Assert.Equal(42, call.Value);
    }

    /// <summary>
    /// Issue #3184 (typed form): a prior cell's function converts to an
    /// explicitly typed function-value slot.
    /// </summary>
    [Fact]
    public void PriorCellFunctionAsValueWithExplicitFunctionType()
    {
        Assert.False(engine.Evaluate("func double(n int) int {\n    return n * 2\n}").HasError);

        var let = engine.Evaluate("let g func(int) int = double");
        Assert.False(let.HasError);

        var call = engine.Evaluate("g(21)");
        Assert.False(call.HasError);
        Assert.Equal(42, call.Value);
    }

    /// <summary>
    /// Issue #3184: a prior cell's function passed directly as a delegate
    /// argument (a value context other than a declaration initializer).
    /// </summary>
    [Fact]
    public void PriorCellFunctionAsArgumentToHigherOrderFunction()
    {
        Assert.False(engine.Evaluate("func addOne(n int) int {\n    return n + 1\n}").HasError);
        Assert.False(engine.Evaluate("func apply(f func(int) int, v int) int {\n    return f(v)\n}").HasError);

        var call = engine.Evaluate("apply(addOne, 41)");
        Assert.False(call.HasError);
        Assert.Equal(42, call.Value);
    }

    [Fact]
    public void SnapshotListsAccumulatedSymbolsWithValues()
    {
        Assert.False(engine.Evaluate("var counter = 10").HasError);
        Assert.False(engine.Evaluate("func addOne(n int) int {\n    return n + 1\n}").HasError);
        Assert.False(engine.Evaluate("""
            struct Point {
                var X int
            }
            """).HasError);
        Assert.False(engine.Evaluate("counter = 42").HasError);

        var state = engine.Snapshot();
        Assert.Contains(state.Variables, v => v.Display.Contains("counter", StringComparison.Ordinal) && v.Display.Contains("42", StringComparison.Ordinal));
        Assert.Contains(state.Functions, f => f.Display.Contains("addOne", StringComparison.Ordinal));
        Assert.Contains(state.Types, t => t.Display.Contains("Point", StringComparison.Ordinal));
        Assert.DoesNotContain(state.Variables, v => v.Display.Contains("<Result>$", StringComparison.Ordinal));
    }
}
