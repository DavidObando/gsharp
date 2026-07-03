// <copyright file="Issue1799MapAndInterfaceSlotConcurrencyInterpreterTests.cs" company="GSharp">
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
/// Issue #1799 — two residual thread-safety/determinism gaps left out of
/// #1718's stated scope:
///
/// 1. <c>Evaluator.EvaluateMapLiteralExpression</c> backed a G# <c>map[K]V</c>
/// with a plain, non-thread-safe <c>Dictionary&lt;,&gt;</c> even though a map
/// value is Go-style reference-shared across goroutines exactly like the
/// frame dictionaries and <see cref="StructValue.Fields"/> #1718 already
/// fixed. Unlike those two, the map's runtime type can't simply become
/// <c>ConcurrentDictionary&lt;,&gt;</c>: <c>MapTypeSymbol.ClrType</c> is
/// <c>Dictionary&lt;,&gt;</c> and is load-bearing for both the binder's
/// CLR-reflection member access (e.g. <c>self.Count</c> on a
/// <c>map[K,V]</c>-typed receiver resolves a real
/// <c>Dictionary&lt;,&gt;.Count</c> <c>PropertyInfo</c>) and the compiled
/// emit backend's real IL for <c>m[k]</c>/<c>delete(m, k)</c> — and
/// <c>ConcurrentDictionary&lt;,&gt;</c> doesn't even expose the same public
/// surface (no public <c>Remove(TKey)</c>, only <c>TryRemove</c>), so
/// swapping the object type would desync reflection-bound member access
/// from the actual instance and break the compiled backend's method
/// lookups. The fix instead keeps the map a real <c>Dictionary&lt;,&gt;</c>
/// and has every interpreter-owned map access (index read, index write,
/// delete, <c>len</c>) take a lock keyed off the dictionary instance, so
/// concurrent goroutine reads/writes on the SAME shared map can no longer
/// corrupt its internal buckets.
///
/// 2. <c>EvaluateConstrainedStaticCallExpression</c>'s "Strategy 2" locals
/// scan (<c>foreach (var kv in frame)</c>) enumerates a frame that became a
/// <c>ConcurrentDictionary</c> in #1718, so when two in-scope locals in the
/// SAME frame both implement the slot's interface, first-match-wins used to
/// depend on ConcurrentDictionary's internal bucket-hash order — which can
/// differ from run to run. The fix sorts each frame's candidates by variable
/// name (ordinal) before scanning, giving a stable, always-reproducible
/// pick.
/// </summary>
public class Issue1799MapAndInterfaceSlotConcurrencyInterpreterTests
{
    [Fact]
    public void ManyGoroutines_WriteDistinctKeysOnSharedMap_AllWritesSurvive()
    {
        // A single map literal is captured by N goroutines, each writing a
        // DIFFERENT key on the SAME shared map at the same time — directly
        // exercising concurrent-access safety of the map's backing
        // dictionary (guarded by a per-instance lock). Mirrors
        // Issue1718FrameConcurrencyInterpreterTests.ManyGoroutines_WriteDistinctFieldsOnSharedClassInstance_AllWritesSurvive
        // but for a map value instead of a class instance.
        const int keyCount = 24;
        var sb = new System.Text.StringBuilder();
        for (var i = 0; i < keyCount; i++)
        {
            sb.AppendLine($"func setK{i}(m map[string,int32]) int32 {{\n    m[\"k{i}\"] = {i + 1}\n    return 0\n}}");
        }

        sb.AppendLine();
        sb.AppendLine("func run() int32 {");
        sb.AppendLine("    var m = map[string,int32]{}");
        sb.AppendLine("    scope {");
        for (var i = 0; i < keyCount; i++)
        {
            sb.AppendLine($"        go setK{i}(m)");
        }

        sb.AppendLine("    }");
        sb.Append("    return ");
        for (var i = 0; i < keyCount; i++)
        {
            sb.Append($"m[\"k{i}\"]");
            if (i < keyCount - 1)
            {
                sb.Append(" + ");
            }
        }

        sb.AppendLine();
        sb.AppendLine("}");
        sb.AppendLine();
        sb.AppendLine("run()");

        var expectedSum = 0;
        for (var i = 0; i < keyCount; i++)
        {
            expectedSum += i + 1;
        }

        var result = Evaluate(sb.ToString());
        AssertNoRealDiagnostics(result);
        Assert.Equal(expectedSum, result.Value);
    }

    [Fact]
    public void ManyConcurrentRuns_GoroutinesWritingSharedMap_NeverCorruptsOrCrashes()
    {
        // Same stress shape as
        // Issue1718FrameConcurrencyInterpreterTests.ManyConcurrentRuns_GoroutineAndSpawnerBothWriteCapturedVariable_NeverCorruptsOrCrashes:
        // run the whole evaluation many times concurrently to maximize the
        // chance any residual plain-Dictionary corruption in the map
        // literal would surface as a thrown exception or a corrupted key
        // count.
        var source = """
            func bump(m map[string,int32]) int32 {
                m["k"] = m["k"] + 1
                return 0
            }

            func run() int32 {
                var m = map[string,int32]{}
                scope {
                    for var i = 0; i < 50; i++ {
                        go bump(m)
                    }
                }

                return m["k"]
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

                    // 50 concurrent racy `m["k"] = m["k"] + 1` increments
                    // starting from the map's zero value (0): a lost update
                    // can only ever under-count, never invent a value
                    // outside [0, 50], and must never throw. Anything
                    // outside that range (or an exception) indicates real
                    // dictionary corruption, not just a benign lost update.
                    if (value < 0 || value > 50)
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

    [Fact]
    public void ManyConcurrentRuns_OneGoroutineRangesWhileOthersWrite_NeverThrowsCollectionModified()
    {
        // Opus review follow-up (blocking gap B1): the language sugar
        // `for k, v in m` isn't currently wired for a native `map[K,V]`
        // literal (only for imported CLR `Dictionary[K,V]`), but the
        // underlying access it would lower to — `m.GetEnumerator()` /
        // `MoveNext()` / `.Current.Key`/`.Value` — is directly reachable
        // today and dispatches through the interpreter's generic
        // CLR-reflection call path (EvaluateImportedInstanceCallExpression /
        // EvaluateClrPropertyAccessExpression), a path the base #1799 fix
        // never touched. One goroutine walks the shared map's enumerator in
        // a hot loop while N others write distinct keys concurrently;
        // without routing GetEnumerator() through GetMapLock (and returning
        // an enumerator over a private clone) this reliably throws
        // InvalidOperationException: "Collection was modified" or a
        // NullReferenceException from a torn bucket read.
        var source = """
            func writer(m map[string,int32], key string, value int32) int32 {
                for var i = 0; i < 20; i++ {
                    m[key] = value
                }

                return 0
            }

            func rangeReader(m map[string,int32]) int32 {
                var total = 0
                for var i = 0; i < 20; i++ {
                    var e = m.GetEnumerator()
                    while e.MoveNext() {
                        total = total + e.Current.Value
                    }
                }

                return total
            }

            func run() int32 {
                var m = map[string,int32]{}
                scope {
                    go rangeReader(m)
                    for var i = 0; i < 16; i++ {
                        go writer(m, "k" + i.ToString(), i)
                    }
                }

                return 0
            }

            run()
            """;

        const int iterations = 200;
        var exceptions = new System.Collections.Concurrent.ConcurrentBag<System.Exception>();
        System.Threading.Tasks.Parallel.For(
            0,
            iterations,
            new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 16 },
            _ =>
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

    [Fact]
    public void ManyConcurrentRuns_LenAndContainsKeyAndKeysReadWhileWriting_NeverThrows()
    {
        // Same gap as above (B1) but for the other reflection-dispatched
        // members named in the review: `len(m)` (Count), `m.ContainsKey(k)`,
        // and `m.Keys` all resolve to real Dictionary<,> members via CLR
        // reflection and must serialize on the same per-map lock as
        // index/delete/range.
        var source = """
            func writer(m map[string,int32], key string, value int32) int32 {
                for var i = 0; i < 20; i++ {
                    m[key] = value
                }

                return 0
            }

            func reader(m map[string,int32]) int32 {
                var total = 0
                for var i = 0; i < 20; i++ {
                    total = total + len(m)
                    if m.ContainsKey("k0") {
                        total = total + 1
                    }

                    for k in m.Keys {
                        total = total + 1
                    }
                }

                return total
            }

            func run() int32 {
                var m = map[string,int32]{}
                scope {
                    go reader(m)
                    for var i = 0; i < 16; i++ {
                        go writer(m, "k" + i.ToString(), i)
                    }
                }

                return 0
            }

            run()
            """;

        const int iterations = 200;
        var exceptions = new System.Collections.Concurrent.ConcurrentBag<System.Exception>();
        System.Threading.Tasks.Parallel.For(
            0,
            iterations,
            new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 16 },
            _ =>
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

    [Fact]
    public void InterfaceSlotResolution_TwoInScopeImplementers_PicksSameOneEveryRun()
    {
        // "Strategy 2" of EvaluateConstrainedStaticCallExpression walks the
        // current call frame for any in-scope StructValue implementing the
        // slot's interface. Neither `a` nor `b` (T.Add's arguments) is
        // T-typed, so Strategy 1's argument-sniff can't resolve the
        // implementer and this call is forced onto Strategy 2 with TWO
        // valid candidates in the SAME frame: `w` (Adder, declared type
        // parameter T) and `other` (Adder2, a concrete, non-generic
        // parameter) both implement IAdd. Ordinal name order picks "other"
        // before "w" ('o' &lt; 'w'), so the resolved implementer — and
        // therefore the result (12 = 3*4 from Adder2, never 7 = 3+4 from
        // Adder) — must be identical on every run, regardless of
        // ConcurrentDictionary's internal bucket-hash order for the frame.
        var source = """
            import System

            sealed interface IAdd {
                shared {
                    func Add(a int32, b int32) int32;
                }
            }

            class Adder : IAdd {
                shared {
                    func Add(a int32, b int32) int32 { return a + b }
                }
            }

            class Adder2 : IAdd {
                shared {
                    func Add(a int32, b int32) int32 { return a * b }
                }
            }

            func Compute[T IAdd](w T, other Adder2, a int32, b int32) int32 {
                return T.Add(a, b)
            }

            Console.WriteLine(Compute(Adder{}, Adder2{}, 3, 4))
            """;

        for (var i = 0; i < 50; i++)
        {
            Assert.Equal("12\n", EvaluateToConsole(source));
        }
    }

    private static EvaluationResult Evaluate(string source)
    {
        // ADR-0082 / issue #722: `go` is gated behind this import.
        var fullSource = "import Gsharp.Extensions.Go\n" + source;
        var tree = SyntaxTree.Parse(SourceText.From(fullSource));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static string EvaluateToConsole(string source)
    {
        var previousOut = System.Console.Out;
        try
        {
            using var writer = new System.IO.StringWriter();
            System.Console.SetOut(writer);
            var tree = SyntaxTree.Parse(SourceText.From(source));
            var compilation = new Compilation(tree);
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            AssertNoRealDiagnostics(result);
            return writer.ToString();
        }
        finally
        {
            System.Console.SetOut(previousOut);
        }
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
