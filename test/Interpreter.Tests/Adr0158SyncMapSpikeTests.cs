// <copyright file="Adr0158SyncMapSpikeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0158 feasibility spike (issue #3209): a G#-authored synchronized map
/// prototype — a plain <c>map[K,V]</c> field guarded by <c>lock</c> on a
/// private, never-leaked monitor — expressed entirely with today's language
/// surface and exercised through real emitted execution.
///
/// These tests are also the successors to the four deleted
/// <c>Issue1799MapAndInterfaceSlotConcurrencyInterpreterTests</c> map
/// concurrency guarantees (see the pre-deletion sources at commit
/// <c>5cd0d766</c>): distinct-key writes all survive, concurrent increments
/// never corrupt (and are exact here, because <c>Update</c> is atomic —
/// stronger than the evaluator-era racy guarantee), enumeration-while-writing
/// never throws, and <c>Len</c>/<c>Contains</c>/<c>Keys</c> reads under write
/// load never throw. The guarantees attach to the <c>SyncMap</c> type, not to
/// plain <c>map[K,V]</c>, which stays unsynchronized per #3205.
///
/// Discrimination witness (ADR-0154): removing the <c>lock</c> statements
/// from <see cref="SyncMapPrototype"/> (the unsynchronized mutant) makes the
/// stress tests below fail — see the ADR's Evidence section for the recorded
/// mutant runs.
/// </summary>
[Trait("Category", "Adr0158Spike")]
public class Adr0158SyncMapSpikeTests
{
    /// <summary>
    /// The spike's G#-authored synchronized map. Everything here is today's
    /// language surface: a class with a private map field used as the hidden
    /// monitor (never leaked, so no foreign code can lock it — the
    /// Java-synchronized pitfall the design must avoid), `lock` statements
    /// (which already lower to Monitor.Enter/try/finally/Monitor.Exit per
    /// issue #1885), function-typed parameters for the atomic Update, and
    /// slice/append for the Keys snapshot. The shipped
    /// Gsharp.Extensions.Sync version is the generic, ConcurrentDictionary-
    /// backed form of this class (see SyncMapGenericShape_CompilesAndRuns;
    /// the generic map-field variant is blocked by #3303).
    /// </summary>
    private const string SyncMapPrototype = """
        class SyncMap {
            private var items map[string, int32]

            init() {
                items = map[string, int32]{}
            }

            func Store(key string, value int32) {
                lock items {
                    items[key] = value
                }
            }

            func Load(key string) int32 {
                lock items {
                    return items[key]
                }
            }

            func Update(key string, f (int32) -> int32) {
                lock items {
                    items[key] = f(items[key])
                }
            }

            func Delete(key string) {
                lock items {
                    items.Remove(key)
                }
            }

            func Length() int32 {
                lock items {
                    return items.Count
                }
            }

            func Contains(key string) bool {
                lock items {
                    return items.ContainsKey(key)
                }
            }

            func Keys() []string {
                lock items {
                    var ks = System.Collections.Generic.List[string]()
                    for k in items.Keys {
                        ks.Add(k!!)
                    }
                    return ks.ToArray()
                }
            }

            func Range(action (string, int32) -> void) {
                lock items {
                    var e = items.GetEnumerator()
                    while e.MoveNext() {
                        action(e.Current.Key, e.Current.Value)
                    }
                }
            }
        }
        """;

    /// <summary>
    /// Successor of Issue1799 test A
    /// (ManyGoroutines_WriteDistinctKeysOnSharedMap_AllWritesSurvive):
    /// N goroutines each write a distinct key into one shared SyncMap; every
    /// write must survive. The evaluator-era emitted-oracle pilot measured
    /// 274/300 surviving writes for plain map — the SyncMap guarantee is
    /// all 300.
    /// </summary>
    [Fact]
    public void SyncMap_ManyGoroutines_WriteDistinctKeys_AllWritesSurvive()
    {
        const int goroutines = 24;
        var sb = new StringBuilder();
        sb.AppendLine(SyncMapPrototype);
        sb.AppendLine();
        for (var i = 0; i < goroutines; i++)
        {
            sb.AppendLine($"func setK{i}(m SyncMap) int32 {{\n    m.Store(\"k{i}\", {i + 1})\n    return 0\n}}");
        }

        sb.AppendLine();
        sb.AppendLine("func run() int32 {");
        sb.AppendLine("    var m = SyncMap()");
        sb.AppendLine("    scope {");
        for (var i = 0; i < goroutines; i++)
        {
            sb.AppendLine($"        go setK{i}(m)");
        }

        sb.AppendLine("    }");
        sb.Append("    return ");
        for (var i = 0; i < goroutines; i++)
        {
            sb.Append($"m.Load(\"k{i}\")");
            if (i < goroutines - 1)
            {
                sb.Append(" + ");
            }
        }

        sb.AppendLine();
        sb.AppendLine("}");
        sb.AppendLine();
        sb.AppendLine("run()");

        var expectedSum = 0;
        for (var i = 0; i < goroutines; i++)
        {
            expectedSum += i + 1;
        }

        var result = Evaluate(sb.ToString());
        AssertNoRealDiagnostics(result);
        Assert.Equal(expectedSum, result.Value);
    }

    /// <summary>
    /// Successor of Issue1799 test B
    /// (ManyConcurrentRuns_GoroutinesWritingSharedMap_NeverCorruptsOrCrashes):
    /// 50 goroutines increment the same key. The deleted test could only
    /// assert "no corruption, value in range" because `m[k] = m[k] + 1` is a
    /// racy read-modify-write; SyncMap.Update(key, f) holds the monitor
    /// across the read-modify-write, so the count is exact — a strictly
    /// stronger guarantee. Stressed under Parallel.For to maximize the odds
    /// that a synchronization bug would surface.
    /// </summary>
    [Fact]
    public void SyncMap_ConcurrentIncrements_AreExact_NeverCorruptOrCrash()
    {
        var source = SyncMapPrototype + """


            func bump(m SyncMap) int32 {
                m.Update("k", func(v int32) int32 { return v + 1 })
                return 0
            }

            func run() int32 {
                var m = SyncMap()
                scope {
                    for var i = 0; i < 50; i++ {
                        go bump(m)
                    }
                }

                return m.Load("k")
            }

            run()
            """;

        const int iterations = 40;
        var exceptions = new System.Collections.Concurrent.ConcurrentBag<System.Exception>();
        var wrongCounts = new System.Collections.Concurrent.ConcurrentBag<int>();
        System.Threading.Tasks.Parallel.For(
            0,
            iterations,
            new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 8 },
            i =>
            {
                try
                {
                    var result = Evaluate(source);
                    AssertNoRealDiagnostics(result);
                    var value = (int)result.Value;
                    if (value != 50)
                    {
                        wrongCounts.Add(value);
                    }
                }
                catch (System.Exception ex)
                {
                    exceptions.Add(ex);
                }
            });

        Assert.Empty(exceptions);
        Assert.Empty(wrongCounts);
    }

    /// <summary>
    /// Successor of Issue1799 test C
    /// (ManyConcurrentRuns_OneGoroutineRangesWhileOthersWrite_NeverThrowsCollectionModified):
    /// one goroutine repeatedly Ranges over the SyncMap while 16 writers
    /// store — no InvalidOperationException ("collection was modified"), no
    /// corruption, ever.
    /// </summary>
    [Fact]
    public void SyncMap_RangeWhileWriting_NeverThrows()
    {
        var source = SyncMapPrototype + """


            func writer(m SyncMap, key string, value int32) int32 {
                for var i = 0; i < 20; i++ {
                    m.Store(key, value)
                }
                return 0
            }

            func rangeReader(m SyncMap) int32 {
                var total = 0
                for var i = 0; i < 20; i++ {
                    m.Range(func(k string, v int32) {
                        total = total + v
                    })
                }
                return total
            }

            func run() int32 {
                var m = SyncMap()
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

        RunStress(source, iterations: 30);
    }

    /// <summary>
    /// Successor of Issue1799 test D
    /// (ManyConcurrentRuns_LenAndContainsKeyAndKeysReadWhileWriting_NeverThrows):
    /// Len(), Contains(), and a Keys() snapshot are read continuously while
    /// 16 writer goroutines store — never throws.
    /// </summary>
    [Fact]
    public void SyncMap_LenContainsAndKeysUnderWriteLoad_NeverThrows()
    {
        var source = SyncMapPrototype + """


            func writer(m SyncMap, key string, value int32) int32 {
                for var i = 0; i < 20; i++ {
                    m.Store(key, value)
                }
                return 0
            }

            func reader(m SyncMap) int32 {
                var total = 0
                for var i = 0; i < 20; i++ {
                    total = total + m.Length()
                    if m.Contains("k0") {
                        total = total + 1
                    }
                    for k in m.Keys() {
                        total = total + 1
                    }
                }
                return total
            }

            func run() int32 {
                var m = SyncMap()
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

        RunStress(source, iterations: 30);
    }

    /// <summary>
    /// The v0 (docs-guidance) leg of the ADR: ConcurrentDictionary is fully
    /// reachable from G# today via plain CLR interop — no compiler change,
    /// no library type. This is the capability floor the issue records
    /// ("the goal is ergonomics, not capability").
    /// </summary>
    [Fact]
    public void InteropToday_ConcurrentDictionary_DistinctKeyWrites_AllSurvive()
    {
        var source = """
            import System.Collections.Concurrent

            func store(m ConcurrentDictionary[string, int32], key string, value int32) int32 {
                var ok = m.TryAdd(key, value)
                return 0
            }

            func run() int32 {
                var m = ConcurrentDictionary[string, int32]()
                scope {
                    for var i = 0; i < 24; i++ {
                        go store(m, "k" + i.ToString(), i + 1)
                    }
                }

                var total = 0
                for var i = 0; i < 24; i++ {
                    var v = 0
                    var ok = m.TryGetValue("k" + i.ToString(), out v)
                    total = total + v
                }

                return total
            }

            run()
            """;

        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(300, result.Value);
    }

    /// <summary>
    /// Feasibility probe for the shipped Gsharp.Extensions.Sync form: a
    /// generic SyncMap[K, V] backed by a ConcurrentDictionary[K, V] interop
    /// field, used at two closed instantiations. This compiles and runs
    /// today, so the generic library type needs no compiler work at all.
    /// (The lock-based monomorphic prototype above does NOT generalize yet:
    /// a `map[K, V]` field over type parameters compiles but NREs at
    /// runtime — its `map[K, V]{}` literal never reaches the field — and
    /// `map[K, V] != nil` is not a defined operator. Recorded in the ADR as
    /// a filed compiler gap; the ConcurrentDictionary backing sidesteps it
    /// and is the better backing anyway.)
    /// </summary>
    [Fact]
    public void SyncMapGenericShape_CompilesAndRuns()
    {
        var source = """
            import System.Collections.Concurrent

            class GenericSyncMap[K, V any] {
                private var items ConcurrentDictionary[K, V]

                init() {
                    items = ConcurrentDictionary[K, V]()
                }

                func Store(key K, value V) {
                    items[key] = value
                }

                func Load(key K) V {
                    var v V
                    var ok = items.TryGetValue(key, out v)
                    return v
                }

                func Length() int32 {
                    return items.Count
                }
            }

            func run() int32 {
                var m = GenericSyncMap[string, int32]()
                m.Store("a", 40)
                m.Store("b", 2)
                m.Store("c", 58)

                var names = GenericSyncMap[int32, string]()
                names.Store(1, "one")

                var total = m.Load("a") + m.Load("b") + m.Load("c") + m.Length()
                if names.Load(1) == "one" {
                    total = total + 100
                }

                return total
            }

            run()
            """;

        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(40 + 2 + 58 + 3 + 100, result.Value);
    }

    private static void RunStress(string source, int iterations)
    {
        var exceptions = new System.Collections.Concurrent.ConcurrentBag<System.Exception>();
        System.Threading.Tasks.Parallel.For(
            0,
            iterations,
            new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 8 },
            i =>
            {
                try
                {
                    var result = Evaluate(source);
                    AssertNoRealDiagnostics(result);
                    Assert.Equal(0, result.Value);
                }
                catch (System.Exception ex)
                {
                    exceptions.Add(ex);
                }
            });

        Assert.Empty(exceptions);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        // ADR-0082 / issue #722: `go` is gated behind this import.
        var fullSource = source;
        return EmittedOracle.Evaluate(fullSource);
    }

    /// <summary>
    /// GS0286 (ADR-0066 D5) flags declaration-before-use ordering as a
    /// warning, not an error — same allowance as the sibling concurrency
    /// suites.
    /// </summary>
    private static void AssertNoRealDiagnostics(EmittedOracleResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Id != "GS0286");
    }
}
