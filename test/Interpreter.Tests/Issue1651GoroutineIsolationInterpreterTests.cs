// <copyright file="Issue1651GoroutineIsolationInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1651 — the interpreter is a tree-walker with shared mutable
/// evaluation state (a <c>locals</c> frame stack plus the control-transfer
/// flags <c>isReturning</c>/<c>pendingGotoLabel</c>/<c>lastValue</c>). A
/// spawned <c>go</c>/<c>scope</c> task ran that shared state on a
/// ThreadPool thread guarded only by a lock shared between goroutines —
/// the spawning ("main") thread never took that lock and kept mutating the
/// same locals stack and flags concurrently. That let a `return` inside a
/// goroutine flip the caller's isReturning/lastValue (making an unrelated
/// function return early with the goroutine's value) and let interleaved
/// Push/Pop between threads corrupt frame resolution for both sides.
///
/// The fix gives every thread (main and every goroutine) its own
/// <c>ExecutionState</c> — a clone of the locals chain the goroutine's
/// closure captured, plus fresh control-transfer flags — while global
/// variables/static fields/the iterator cache/the shared Random instance
/// remain the only state shared across threads, guarded by a lock. These
/// tests cover: a goroutine's `return` not leaking into the caller, many
/// concurrently-recursing goroutines not corrupting the main thread's
/// locals, closure visibility of captured enclosing variables, and that
/// channel/scope/WhenAll semantics still work.
/// </summary>
public class Issue1651GoroutineIsolationInterpreterTests
{
    [Fact]
    public void ReturnInsideScopedGoroutine_DoesNotLeakIntoCaller()
    {
        // spawnee's `return 999` used to be able to flip the shared
        // isReturning/lastValue while run() kept executing statements
        // after `go spawnee()`, making run() return 999 instead of 42.
        var source = """
            func spawnee() int32 {
                return 999
            }

            func run() int32 {
                scope {
                    go spawnee()
                    let a = 1
                    let b = 2
                }
                return 42
            }

            run()
            """;
        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ReturnInsideFireAndForgetGoroutine_DoesNotLeakIntoCaller()
    {
        // Same hazard as above but for the un-scoped, fire-and-forget `go`
        // path: force the goroutine to be actively running (past its own
        // locals-frame setup, about to hit `return`) concurrently with the
        // caller's remaining statements via a rendezvous channel.
        var source = """
            let started = make(chan int32, 1)

            func spawnee() int32 {
                started <- 1
                return 999
            }

            func run() int32 {
                go spawnee()
                let signal = <-started
                let a = 1
                let b = 2
                return a + b
            }

            run()
            """;
        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ManyConcurrentRecursingGoroutines_DoNotCorruptMainThreadLocals()
    {
        // Every goroutine recurses deeply (pushing/popping many locals
        // frames) while the main thread does the same for its own call.
        // Pre-fix, interleaved Push/Pop on the single shared locals stack
        // could corrupt frame resolution on either side; post-fix every
        // thread has its own locals stack so the result is deterministic.
        var source = """
            func fib(n int32) int32 {
                if n < 2 {
                    return n
                }
                return fib(n - 1) + fib(n - 2)
            }

            func run() int32 {
                for var i = 0; i < 50; i++ {
                    go fib(18)
                }
                return fib(15)
            }

            run()
            """;
        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(610, result.Value);
    }

    [Fact]
    public void Goroutine_SeesCapturedEnclosingVariable_ClosureVisibilityPreserved()
    {
        // A goroutine's own locals stack is a clone (isolated Push/Pop),
        // not a fresh empty stack — it must still resolve variables its
        // closure captured from the enclosing scope, like a real closure.
        var source = """
            let ch = make(chan int32, 1)

            func run() int32 {
                let x = 10
                let read = func() int32 {
                    ch <- x
                    return 0
                }
                go read()
                return <-ch
            }

            run()
            """;
        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void ScopeFailure_StillPropagatesAfterIsolationChange()
    {
        // Existing structured-concurrency semantics (ADR-0022): a failure
        // in a scoped goroutine must still surface at scope exit, not be
        // silently swallowed, after switching away from the single goLock.
        var source = """
            import System

            func boom() int32 {
                let n = Int32.Parse("bad")
                return n
            }

            func run() int32 {
                scope {
                    go boom()
                }
                return 0
            }

            run()
            """;
        var tree = SyntaxTree.Parse(SourceText.From("import Gsharp.Extensions.Go\n" + source));
        var compilation = new Compilation(tree);
        EvaluationResult result = null;
        System.Exception thrown = null;
        try
        {
            result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        }
        catch (System.Exception ex)
        {
            thrown = ex;
        }

        Assert.True(
            thrown != null || (result != null && !result.Diagnostics.IsEmpty),
            "Scope did not surface the failure from the scoped goroutine.");
    }

    [Fact]
    public void ChannelSendReceiveAcrossGoroutine_StillWorks()
    {
        // Baseline channel regression: unbuffered send/receive across a
        // fire-and-forget goroutine must still rendezvous correctly.
        var source = """
            let ch = make(chan int32)

            func send() int32 {
                ch <- 7
                return 0
            }

            func run() int32 {
                go send()
                return <-ch
            }

            run()
            """;
        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NestedScopes_ManyConcurrentRuns_DoNotCorruptScopeFrames()
    {
        // Regression for a task-inlining race found while validating this
        // fix: the default TaskScheduler is free to run a queued `go` task's
        // body INLINE on the very thread that is blocked awaiting it in
        // Task.WhenAll(...).GetAwaiter().GetResult() (a documented .NET
        // optimization to avoid starving the pool). The first version of
        // this fix set executionState.Value = goroutineState for the
        // duration of the goroutine but never restored it, so an inlined run
        // permanently clobbered the blocked thread's OWN ExecutionState
        // (live ScopeFrames/Locals) with the goroutine's fresh one. Once the
        // wait unblocked, the outer scope's `ScopeFrames.Pop()` then saw an
        // empty stack it never pushed onto and threw
        // InvalidOperationException("Stack empty"). This only reproduced
        // under enough concurrent pressure for inlining to actually occur —
        // a single run rarely hit it — so this test hammers many concurrent
        // evaluations of the same nested-scope source.
        var source = """
            func work() int32 {
                return 1
            }

            scope {
                scope {
                    go work()
                }
                go work()
            }
            """;

        const int iterations = 300;
        var exceptions = new System.Collections.Concurrent.ConcurrentBag<System.Exception>();
        System.Threading.Tasks.Parallel.For(
            0,
            iterations,
            new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 32 },
            i =>
            {
                try
                {
                    var result = Evaluate(source);
                    AssertNoRealDiagnostics(result);
                }
                catch (System.Exception ex)
                {
                    exceptions.Add(ex);
                }
            });

        Assert.Empty(exceptions);
    }

    private static EvaluationResult Evaluate(string source)
    {
        // ADR-0082 / issue #722: `go` is gated behind this import.
        var fullSource = "import Gsharp.Extensions.Go\n" + source;
        var tree = SyntaxTree.Parse(SourceText.From(fullSource));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    /// <summary>
    /// Some fixtures below place a `let`/`make(chan ...)` declaration ahead
    /// of the functions that use it (for readability) and a statement
    /// after them (the call under test) — GS0286 (ADR-0066 D5) flags that
    /// split-TLS layout as a warning, not an error. Filter it the same way
    /// <c>ScopeStatementTests.Scope_WithSendInsideGo_Binds</c> does so
    /// these tests exercise goroutine isolation, not the layout warning.
    /// </summary>
    private static void AssertNoRealDiagnostics(EvaluationResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Id != "GS0286");
    }
}
