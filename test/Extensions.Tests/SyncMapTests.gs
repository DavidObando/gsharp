// <copyright file="SyncMapTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Extensions.Tests

import Gsharp.Extensions.Sync
import System
import System.Collections
import System.Collections.Concurrent
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Tasks
import Xunit

/// Coverage for `Gsharp.Extensions.Sync.SyncMap[K, V]` (ADR-0158 /
/// issue #3209), exercised directly against the compiled G#-authored
/// assembly with real threads.
///
/// The four concurrency guarantees here are the successors of the
/// evaluator-era Issue1799 map-concurrency suite deleted with ADR-0156
/// Phase 3c (pre-deletion sources at commit `5cd0d766`): distinct-key
/// writes all survive, read-modify-write increments are exact (stronger
/// than the deleted racy-increment guarantee — `Update` is atomic),
/// enumeration while writing never throws, and size/membership/key-snapshot
/// reads under write load never throw. Per ADR-0158 they attach to
/// `SyncMap`; plain `map[K, V]` deliberately carries none of them
/// (#3205).
///
/// Discrimination witnesses (ADR-0154, product mutants — recorded in PR
/// #3305): stripping the `lock` statements from `Sync.gs` breaks
/// (cref:Update_ConcurrentIncrements_AreExact); swapping the backing
/// `ConcurrentDictionary` for a plain `Dictionary` breaks the
/// enumeration-under-write guarantees.
open class SyncMapTests {
    // ---- Unit coverage -------------------------------------------------
    @Fact
    func StoreAndLoad_RoundTrips() {
        let m = SyncMap[string, int32]()
        m.Store("a", 42)
        Assert.Equal(42, m.Load("a"))
        m.Store("a", 7)
        Assert.Equal(7, m.Load("a"))
    }

    @Fact
    func Load_AbsentKey_ReturnsZeroValue() {
        let m = SyncMap[string, int32]()
        Assert.Equal(0, m.Load("missing"))
    }

    @Fact
    func Update_AbsentKey_AppliesToZeroValue_AndStores() {
        let m = SyncMap[string, int32]()
        let result = m.Update("k", (v int32) -> v + 5)
        Assert.Equal(5, result)
        Assert.Equal(5, m.Load("k"))
    }

    @Fact
    func Update_PresentKey_AppliesToCurrent_AndReturnsNewValue() {
        let m = SyncMap[string, int32]()
        m.Store("k", 10)
        Assert.Equal(11, m.Update("k", (v int32) -> v + 1))
        Assert.Equal(11, m.Load("k"))
    }

    @Fact
    func Update_NullProjection_Throws() {
        let m = SyncMap[string, int32]()
        Assert.Throws[ArgumentNullException](
            func () object? {
                return m.Update("k", default((int32) -> int32))
            }
        )
    }

    @Fact
    func Delete_ReportsPresence_AndRemoves() {
        let m = SyncMap[string, int32]()
        m.Store("k", 1)
        Assert.True(m.Delete("k"))
        Assert.False(m.Contains("k"))
        Assert.False(m.Delete("k"))
    }

    @Fact
    func LenAndContains_TrackEntries() {
        let m = SyncMap[string, int32]()
        Assert.Equal(0, m.Length())
        Assert.False(m.Contains("a"))
        m.Store("a", 1)
        m.Store("b", 2)
        Assert.Equal(2, m.Length())
        Assert.True(m.Contains("a"))
        Assert.True(m.Contains("b"))
    }

    @Fact
    func Keys_ReturnsSnapshotOfAllKeys() {
        let m = SyncMap[string, int32]()
        m.Store("a", 1)
        m.Store("b", 2)
        m.Store("c", 3)
        let keys = m.Keys()
        Assert.Equal([]string{"a", "b", "c"}, keys.OrderBy((k string) -> k).ToArray())
        // Snapshot: later writes do not mutate an already-taken snapshot.
        m.Store("d", 4)
        Assert.Equal(3, keys.Length)
    }

    @Fact
    func Range_VisitsEveryEntry() {
        let m = SyncMap[string, int32]()
        m.Store("a", 1)
        m.Store("b", 2)
        let seen = ConcurrentDictionary[string, int32]()
        m.Range(
            (k string, v int32) -> {
                seen[k] = v
            }
        )
        Assert.Equal(2, seen.Count)
        Assert.Equal(1, seen["a"])
        Assert.Equal(2, seen["b"])
    }

    @Fact
    func Range_NullAction_Throws() {
        let m = SyncMap[string, int32]()
        Assert.Throws[ArgumentNullException](() -> m.Range(default((string, int32) -> void)))
    }

    @Fact
    func ReferenceValueType_RoundTrips() {
        let m = SyncMap[int32, string]()
        m.Store(1, "one")
        Assert.Equal("one", m.Load(1))
    }

    // ---- Issue1799 successor guarantee A: distinct-key writes ----------
    @Fact
    func ManyThreads_WriteDistinctKeys_AllWritesSurvive() {
        const keys = 64
        const iterations = 200
        for var run = 0; run < iterations; run++ {
            let m = SyncMap[string, int32]()
            Parallel.For(
                0,
                keys,
                ParallelOptions{MaxDegreeOfParallelism: 16},
                (i int32) -> m.Store("k" + i.ToString(), i + 1)
            )
            Assert.Equal(keys, m.Length())
            for var i = 0; i < keys; i++ {
                Assert.Equal(i + 1, m.Load("k" + i.ToString()))
            }
        }
    }

    // ---- Issue1799 successor guarantee B: exact concurrent increments --
    @Fact
    func Update_ConcurrentIncrements_AreExact() {
        // The deleted evaluator-era test could only assert "no corruption,
        // value in range" for racy `m[k] = m[k] + 1`; Update holds the
        // write monitor across the read-modify-write, so the count is
        // exact — the strictly stronger successor guarantee.
        const increments = 200
        const iterations = 100
        for var run = 0; run < iterations; run++ {
            let m = SyncMap[string, int32]()
            Parallel.For(
                0,
                increments,
                ParallelOptions{MaxDegreeOfParallelism: 16},
                (_ int32) -> m.Update("k", (v int32) -> v + 1)
            )
            Assert.Equal(increments, m.Load("k"))
        }
    }

    @Fact
    async func Update_IsAtomicAgainstStoreAndDelete() {
        // Update must serialize against ALL writes, not just other
        // Updates: interleave Store/Delete churn on other keys plus
        // increments on a shared counter key and require the counter to
        // stay exact.
        const increments = 200
        let m = SyncMap[string, int32]()
        let churn = Task.Run(
            () -> {
                for var i = 0; i < 500; i++ {
                    m.Store("noise" + (i % 8).ToString(), i)
                    m.Delete("noise" + ((i + 4) % 8).ToString())
                }
            }
        )
        Parallel.For(
            0,
            increments,
            ParallelOptions{MaxDegreeOfParallelism: 16},
            (_ int32) -> m.Update("counter", (v int32) -> v + 1)
        )
        await churn
        Assert.Equal(increments, m.Load("counter"))
    }

    // ---- Issue1799 successor guarantee C: enumeration while writing ----
    @Fact
    async func Range_WhileWriting_NeverThrows() {
        let m = SyncMap[string, int32]()
        using let stop = CancellationTokenSource()
        let writers = Enumerable
            .Range(0, 8)
            .Select(
            (w int32) -> Task.Run(
                () -> {
                    var i = 0
                    while !stop.Token.IsCancellationRequested {
                        m.Store("k" + (i % 32).ToString(), i)
                        m.Delete("k" + ((i + 16) % 32).ToString())
                        i++
                    }
                }
            )
        )
            .ToArray()
        // The guarantee under test: ranging concurrently with writers never
        // throws (no "collection was modified", no corruption).
        for var pass = 0; pass < 400; pass++ {
            var total = 0
            m.Range(
                (k string, v int32) -> {
                    total += v
                }
            )
        }
        stop.Cancel()
        await Task.WhenAll(writers)
    }

    // ---- Issue1799 successor guarantee D: Len/Contains/Keys under load --
    @Fact
    async func LenContainsAndKeys_UnderWriteLoad_NeverThrow() {
        let m = SyncMap[string, int32]()
        using let stop = CancellationTokenSource()
        let writers = Enumerable
            .Range(0, 8)
            .Select(
            (w int32) -> Task.Run(
                () -> {
                    var i = 0
                    while !stop.Token.IsCancellationRequested {
                        m.Store("k" + (i % 32).ToString(), i)
                        m.Delete("k" + ((i + 16) % 32).ToString())
                        i++
                    }
                }
            )
        )
            .ToArray()
        for var pass = 0; pass < 400; pass++ {
            let len = m.Length()
            Assert.InRange(len, 0, 32)
            let _ = m.Contains("k0")
            let keys = m.Keys()
            Assert.True(keys.Length <= 32)
        }
        stop.Cancel()
        await Task.WhenAll(writers)
    }

    // ---- Encapsulation: the monitor/backing store never leaks ----------
    @Fact
    func BackingStoreIsPrivate_NoPublicFieldsOrDictionaryProperties() {
        // ADR-0158's hidden-monitor rule is load-bearing: if the backing
        // ConcurrentDictionary were reachable, callers could bypass
        // Update's atomicity or lock the monitor from outside (the Java
        // synchronized-on-instance pitfall). Pin it structurally.
        let type = typeof(SyncMap[string, int32])
        Assert.Empty(type.GetFields()) // no public instance fields
        Assert.DoesNotContain(
            type.GetProperties(),
            (p PropertyInfo) -> typeof(IDictionary).IsAssignableFrom(p.PropertyType) ||
                p
                .PropertyType
                .Name
                .Contains("Dictionary")
        )
    }
}
