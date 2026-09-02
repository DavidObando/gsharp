// <copyright file="SyncMapTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Extensions.Sync;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// Coverage for <c>Gsharp.Extensions.Sync.SyncMap[K, V]</c> (ADR-0158 /
/// issue #3209), exercised directly against the compiled G#-authored
/// assembly with real threads.
///
/// The four concurrency guarantees here are the successors of the
/// evaluator-era Issue1799 map-concurrency suite deleted with ADR-0156
/// Phase 3c (pre-deletion sources at commit <c>5cd0d766</c>): distinct-key
/// writes all survive, read-modify-write increments are exact (stronger
/// than the deleted racy-increment guarantee — <c>Update</c> is atomic),
/// enumeration while writing never throws, and size/membership/key-snapshot
/// reads under write load never throw. Per ADR-0158 they attach to
/// <c>SyncMap</c>; plain <c>map[K, V]</c> deliberately carries none of them
/// (#3205).
///
/// Discrimination witnesses (ADR-0154, product mutants — recorded in PR
/// #3305): stripping the <c>lock</c> statements from <c>Sync.gs</c> breaks
/// <see cref="Update_ConcurrentIncrements_AreExact"/>; swapping the backing
/// <c>ConcurrentDictionary</c> for a plain <c>Dictionary</c> breaks the
/// enumeration-under-write guarantees.
/// </summary>
public class SyncMapTests
{
    // ---- Unit coverage -------------------------------------------------

    [Fact]
    public void StoreAndLoad_RoundTrips()
    {
        var m = new SyncMap<string, int>();
        m.Store("a", 42);
        Assert.Equal(42, m.Load("a"));

        m.Store("a", 7);
        Assert.Equal(7, m.Load("a"));
    }

    [Fact]
    public void Load_AbsentKey_ReturnsZeroValue()
    {
        var m = new SyncMap<string, int>();
        Assert.Equal(0, m.Load("missing"));
    }

    [Fact]
    public void Update_AbsentKey_AppliesToZeroValue_AndStores()
    {
        var m = new SyncMap<string, int>();
        var result = m.Update("k", v => v + 5);
        Assert.Equal(5, result);
        Assert.Equal(5, m.Load("k"));
    }

    [Fact]
    public void Update_PresentKey_AppliesToCurrent_AndReturnsNewValue()
    {
        var m = new SyncMap<string, int>();
        m.Store("k", 10);
        Assert.Equal(11, m.Update("k", v => v + 1));
        Assert.Equal(11, m.Load("k"));
    }

    [Fact]
    public void Update_NullProjection_Throws()
    {
        var m = new SyncMap<string, int>();
        Assert.Throws<ArgumentNullException>(() => m.Update("k", null!));
    }

    [Fact]
    public void Delete_ReportsPresence_AndRemoves()
    {
        var m = new SyncMap<string, int>();
        m.Store("k", 1);
        Assert.True(m.Delete("k"));
        Assert.False(m.Contains("k"));
        Assert.False(m.Delete("k"));
    }

    [Fact]
    public void LenAndContains_TrackEntries()
    {
        var m = new SyncMap<string, int>();
        Assert.Equal(0, m.Length());
        Assert.False(m.Contains("a"));

        m.Store("a", 1);
        m.Store("b", 2);
        Assert.Equal(2, m.Length());
        Assert.True(m.Contains("a"));
        Assert.True(m.Contains("b"));
    }

    [Fact]
    public void Keys_ReturnsSnapshotOfAllKeys()
    {
        var m = new SyncMap<string, int>();
        m.Store("a", 1);
        m.Store("b", 2);
        m.Store("c", 3);

        var keys = m.Keys();
        Assert.Equal(new[] { "a", "b", "c" }, keys.OrderBy(k => k).ToArray());

        // Snapshot: later writes do not mutate an already-taken snapshot.
        m.Store("d", 4);
        Assert.Equal(3, keys.Length);
    }

    [Fact]
    public void Range_VisitsEveryEntry()
    {
        var m = new SyncMap<string, int>();
        m.Store("a", 1);
        m.Store("b", 2);

        var seen = new ConcurrentDictionary<string, int>();
        m.Range((k, v) => seen[k] = v);

        Assert.Equal(2, seen.Count);
        Assert.Equal(1, seen["a"]);
        Assert.Equal(2, seen["b"]);
    }

    [Fact]
    public void Range_NullAction_Throws()
    {
        var m = new SyncMap<string, int>();
        Assert.Throws<ArgumentNullException>(() => m.Range(null!));
    }

    [Fact]
    public void ReferenceValueType_RoundTrips()
    {
        var m = new SyncMap<int, string>();
        m.Store(1, "one");
        Assert.Equal("one", m.Load(1));
    }

    // ---- Issue1799 successor guarantee A: distinct-key writes ----------

    [Fact]
    public void ManyThreads_WriteDistinctKeys_AllWritesSurvive()
    {
        const int keys = 64;
        const int iterations = 200;

        for (var run = 0; run < iterations; run++)
        {
            var m = new SyncMap<string, int>();
            Parallel.For(
                0,
                keys,
                new ParallelOptions { MaxDegreeOfParallelism = 16 },
                i => m.Store("k" + i, i + 1));

            Assert.Equal(keys, m.Length());
            for (var i = 0; i < keys; i++)
            {
                Assert.Equal(i + 1, m.Load("k" + i));
            }
        }
    }

    // ---- Issue1799 successor guarantee B: exact concurrent increments --

    [Fact]
    public void Update_ConcurrentIncrements_AreExact()
    {
        // The deleted evaluator-era test could only assert "no corruption,
        // value in range" for racy `m[k] = m[k] + 1`; Update holds the
        // write monitor across the read-modify-write, so the count is
        // exact — the strictly stronger successor guarantee.
        const int increments = 200;
        const int iterations = 100;

        for (var run = 0; run < iterations; run++)
        {
            var m = new SyncMap<string, int>();
            Parallel.For(
                0,
                increments,
                new ParallelOptions { MaxDegreeOfParallelism = 16 },
                _ => m.Update("k", v => v + 1));

            Assert.Equal(increments, m.Load("k"));
        }
    }

    [Fact]
    public async Task Update_IsAtomicAgainstStoreAndDelete()
    {
        // Update must serialize against ALL writes, not just other
        // Updates: interleave Store/Delete churn on other keys plus
        // increments on a shared counter key and require the counter to
        // stay exact.
        const int increments = 200;
        var m = new SyncMap<string, int>();

        var churn = Task.Run(() =>
        {
            for (var i = 0; i < 500; i++)
            {
                m.Store("noise" + (i % 8), i);
                m.Delete("noise" + ((i + 4) % 8));
            }
        });

        Parallel.For(
            0,
            increments,
            new ParallelOptions { MaxDegreeOfParallelism = 16 },
            _ => m.Update("counter", v => v + 1));

        await churn;
        Assert.Equal(increments, m.Load("counter"));
    }

    // ---- Issue1799 successor guarantee C: enumeration while writing ----

    [Fact]
    public async Task Range_WhileWriting_NeverThrows()
    {
        var m = new SyncMap<string, int>();
        using var stop = new CancellationTokenSource();

        var writers = Enumerable.Range(0, 8).Select(w => Task.Run(() =>
        {
            var i = 0;
            while (!stop.Token.IsCancellationRequested)
            {
                m.Store("k" + (i % 32), i);
                m.Delete("k" + ((i + 16) % 32));
                i++;
            }
        })).ToArray();

        // The guarantee under test: ranging concurrently with writers never
        // throws (no "collection was modified", no corruption).
        for (var pass = 0; pass < 400; pass++)
        {
            var total = 0;
            m.Range((k, v) => total += v);
        }

        stop.Cancel();
        await Task.WhenAll(writers);
    }

    // ---- Issue1799 successor guarantee D: Len/Contains/Keys under load --

    [Fact]
    public async Task LenContainsAndKeys_UnderWriteLoad_NeverThrow()
    {
        var m = new SyncMap<string, int>();
        using var stop = new CancellationTokenSource();

        var writers = Enumerable.Range(0, 8).Select(w => Task.Run(() =>
        {
            var i = 0;
            while (!stop.Token.IsCancellationRequested)
            {
                m.Store("k" + (i % 32), i);
                m.Delete("k" + ((i + 16) % 32));
                i++;
            }
        })).ToArray();

        for (var pass = 0; pass < 400; pass++)
        {
            var len = m.Length();
            Assert.InRange(len, 0, 32);
            _ = m.Contains("k0");
            var keys = m.Keys();
            Assert.True(keys.Length <= 32);
        }

        stop.Cancel();
        await Task.WhenAll(writers);
    }

    // ---- Encapsulation: the monitor/backing store never leaks ----------

    [Fact]
    public void BackingStoreIsPrivate_NoPublicFieldsOrDictionaryProperties()
    {
        // ADR-0158's hidden-monitor rule is load-bearing: if the backing
        // ConcurrentDictionary were reachable, callers could bypass
        // Update's atomicity or lock the monitor from outside (the Java
        // synchronized-on-instance pitfall). Pin it structurally.
        var type = typeof(SyncMap<string, int>);
        Assert.Empty(type.GetFields()); // no public instance fields
        Assert.DoesNotContain(
            type.GetProperties(),
            p => typeof(System.Collections.IDictionary).IsAssignableFrom(p.PropertyType)
                 || p.PropertyType.Name.Contains("Dictionary"));
    }
}
