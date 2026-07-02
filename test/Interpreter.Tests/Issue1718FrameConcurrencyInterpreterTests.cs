// <copyright file="Issue1718FrameConcurrencyInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Text;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1718 — a goroutine that captures an enclosing-scope local (a
/// mutable variable a function literal closes over, lowered by
/// <c>CaptureBoxingRewriter</c> into a heap "box" cell, or a class
/// instance passed to multiple goroutines) shares that storage BY
/// REFERENCE with the spawning thread and every other goroutine that
/// captured/received it — that is the whole point of Go-style by-reference
/// closure capture (see <c>Issue1651GoroutineIsolationInterpreterTests
/// .Goroutine_SeesCapturedEnclosingVariable_ClosureVisibilityPreserved</c>).
/// Before this fix, both the interpreter's locals-frame dictionaries
/// (<c>Dictionary&lt;VariableSymbol, object&gt;</c>) and a class/box
/// instance's field dictionary (<c>StructValue.Fields</c>,
/// <c>Dictionary&lt;string, object&gt;</c>) were plain, non-thread-safe
/// <c>Dictionary&lt;,&gt;</c> instances. Concurrent writes from two or more
/// threads to the SAME shared instance can corrupt its internal
/// buckets/entries array (torn state, lost writes, or an
/// <c>InvalidOperationException</c> mid-resize) — a crash class that is
/// harsher than Go's own "this is a user data race" semantics.
///
/// The fix swaps every frame dictionary and <see cref="StructValue.Fields"/>
/// for a <see cref="System.Collections.Concurrent.ConcurrentDictionary{TKey, TValue}"/>,
/// which tolerates concurrent readers/writers without corrupting its
/// internal state (individual key writes still race per Go's own memory
/// model — this only removes the crash/corruption class, not the
/// requirement that user code synchronize logically-ordered updates).
///
/// These tests deliberately avoid wall-clock sleeps: correctness is
/// synchronized through <c>scope</c> (which awaits every <c>go</c> task
/// spawned inside it before returning) and, for the crash-detection test,
/// by running many full evaluations concurrently via <c>Parallel.For</c>
/// and joining on it.
/// </summary>
public class Issue1718FrameConcurrencyInterpreterTests
{
    [Fact]
    public void ManyGoroutines_WriteDistinctFieldsOnSharedClassInstance_AllWritesSurvive()
    {
        // A single class instance ("box") is handed to N goroutines, each of
        // which writes to a DIFFERENT field of the SAME shared
        // StructValue.Fields dictionary at the same time — directly
        // exercising concurrent-write safety of that dictionary. Every
        // field already exists (composite-literal initialized them before
        // the object was shared), so a pre-fix plain Dictionary<,> could
        // still corrupt/lose entries under concurrent set-on-existing-key
        // pressure; post-fix, every field must deterministically hold the
        // value only its own goroutine ever wrote.
        const int fieldCount = 24;
        var sb = new StringBuilder();
        sb.AppendLine("class Box {");
        for (var i = 0; i < fieldCount; i++)
        {
            sb.AppendLine($"    var F{i} int32");
        }

        sb.AppendLine("}");
        sb.AppendLine();
        for (var i = 0; i < fieldCount; i++)
        {
            sb.AppendLine($"func setF{i}(b Box) int32 {{\n    b.F{i} = {i + 1}\n    return 0\n}}");
        }

        sb.AppendLine();
        sb.AppendLine("func run() int32 {");
        sb.Append("    var b = Box{");
        for (var i = 0; i < fieldCount; i++)
        {
            sb.Append($"F{i}: 0");
            if (i < fieldCount - 1)
            {
                sb.Append(", ");
            }
        }

        sb.AppendLine("}");
        sb.AppendLine("    scope {");
        for (var i = 0; i < fieldCount; i++)
        {
            sb.AppendLine($"        go setF{i}(b)");
        }

        sb.AppendLine("    }");
        sb.Append("    return ");
        for (var i = 0; i < fieldCount; i++)
        {
            sb.Append($"b.F{i}");
            if (i < fieldCount - 1)
            {
                sb.Append(" + ");
            }
        }

        sb.AppendLine();
        sb.AppendLine("}");
        sb.AppendLine();
        sb.AppendLine("run()");

        var expectedSum = 0;
        for (var i = 0; i < fieldCount; i++)
        {
            expectedSum += i + 1;
        }

        var result = Evaluate(sb.ToString());
        AssertNoRealDiagnostics(result);
        Assert.Equal(expectedSum, result.Value);
    }

    [Fact]
    public void ManyConcurrentRuns_GoroutineAndSpawnerBothWriteCapturedVariable_NeverCorruptsOrCrashes()
    {
        // Direct repro of the issue's literal scenario: a function literal
        // captures a mutable enclosing local (boxed by CaptureBoxingRewriter
        // into a shared heap cell). Fifty goroutines invoke that SAME
        // closure, and the spawning thread writes the SAME captured
        // variable too, all inside one `scope` block. The individual
        // `counter = counter + 1` read-modify-write is intentionally left
        // unsynchronized (same as an unsynchronized Go `counter++` across
        // goroutines is a data race by design) — this test's contract is
        // "no crash / no corrupted dictionary", not "exact arithmetic",
        // matching Go's own memory model for a racy counter. Running many
        // evaluations concurrently maximizes the chance any residual
        // Dictionary<,> corruption bug would surface as an exception.
        var source = """
            func run() int32 {
                var counter = 0
                let bump = func() int32 {
                    counter = counter + 1
                    return 0
                }

                scope {
                    for var i = 0; i < 50; i++ {
                        go bump()
                    }

                    counter = counter + 1
                }

                return counter
            }

            run()
            """;

        const int iterations = 300;
        var exceptions = new System.Collections.Concurrent.ConcurrentBag<System.Exception>();
        var outOfRangeResults = new System.Collections.Concurrent.ConcurrentBag<int>();
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
                    var value = (int)result.Value;

                    // 51 concurrent increments starting from 0: a torn/lost
                    // update can only ever under-count (never invent a
                    // value outside [1, 51], and never throw). Anything
                    // outside that range indicates real corruption, not
                    // just a benign lost update.
                    if (value < 1 || value > 51)
                    {
                        outOfRangeResults.Add(value);
                    }
                }
                catch (System.Exception ex)
                {
                    exceptions.Add(ex);
                }
            });

        Assert.Empty(exceptions);
        Assert.Empty(outOfRangeResults);
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
    /// See <see cref="Issue1651GoroutineIsolationInterpreterTests.AssertNoRealDiagnostics"/>:
    /// some fixtures place a `let`/`var` declaration ahead of the functions
    /// that use it for readability, which GS0286 (ADR-0066 D5) flags as a
    /// warning, not an error.
    /// </summary>
    private static void AssertNoRealDiagnostics(EvaluationResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Id != "GS0286");
    }
}
