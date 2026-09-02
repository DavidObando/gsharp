// ADR-0158 / issue #3209. `Gsharp.Extensions.Sync` — the G# synchronization
// helper surface. First (and currently only) type: `SyncMap[K, V]`, G#'s
// `sync.Map` analog for state shared across goroutines.
//
// Design decisions (ADR-0158):
//
//   * Method-based API, deliberately without literal or index syntax:
//     `m[k] = m[k] + 1` *looks* atomic and is not, which is exactly the
//     race this type exists to kill. Compound read-modify-write is spelled
//     `Update` and is atomic. (Go's `sync.Map` refuses index syntax for
//     the same reason.)
//
//   * Backed by a private `ConcurrentDictionary[K, V]` — not a locked
//     plain `map[K, V]` (a generic map field is blocked by #3303, and the
//     concurrent backing is better on merits: lock-free reads and
//     mutation-safe enumeration). Reads (`Load`, `Length`, `Contains`) and
//     enumeration (`Keys`, `Range`) never take the monitor.
//
//   * Writes (`Store`, `Delete`, `Update`) serialize on a hidden monitor —
//     the private backing dictionary itself, which never leaks out of this
//     class. Foreign code therefore cannot contend on or interfere with
//     the monitor (the Java synchronized-on-instance pitfall #3209 calls
//     out). Serializing *all* writes is what makes `Update` atomic with
//     respect to every other write, not just other `Update` calls.
//
//   * `Load` returns `V`'s zero value when the key is absent, mirroring a
//     G# map read (which lowers to `TryGetValue`, not `get_Item`).
//
// The retired evaluator-era map-concurrency guarantees (#1799, deleted
// with ADR-0156 Phase 3c) live again here, attached to this type:
// distinct-key concurrent writes all survive, `Update` increments are
// exact, and enumeration / size / membership reads never throw under
// concurrent write load. `test/Extensions.Tests/SyncMapTests.cs` pins all
// four against the compiled assembly.

package Gsharp.Extensions.Sync

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Runtime.CompilerServices

/// A goroutine-safe map for `K` → `V`, G#'s `sync.Map` analog
/// (ADR-0158). Use it when a map must be shared across goroutines; plain
/// `map[K, V]` is not goroutine-safe and concurrent access to one is
/// undefined behavior.
///
/// Reads and enumeration are lock-free on a concurrent backing store;
/// writes serialize on a private monitor so
/// [Update](cref:Gsharp.Extensions.Sync.SyncMap.Update) is an atomic
/// read-modify-write. There is deliberately no index syntax — compound
/// operations must go through `Update`, because `m[k] = m[k] + 1` on a
/// shared map is a race no per-operation locking can fix.
///
/// ```gs
/// import Gsharp.Extensions.Sync
///
/// var m = SyncMap[string, int32]()
/// scope {
///     for var i = 0; i < 50; i++ {
///         go bump(m)   // func bump: m.Update("hits", func(v int32) int32 { return v + 1 })
///     }
/// }
/// let hits = m.Load("hits")   // exactly 50
/// ```
class SyncMap[K, V any] {
    // The backing store doubles as the hidden monitor for writes. It is
    // private and never returned, stored, or otherwise leaked, so no code
    // outside this class can lock it (ADR-0158's hidden-monitor rule).
    private var items ConcurrentDictionary[K, V]

    init() {
        items = ConcurrentDictionary[K, V]()
    }

    /// Stores `value` under `key`, replacing any existing entry.
    ///
    /// @param key the key to write.
    /// @param value the value to store.
    func Store(key K, value V) {
        lock items {
            items[key] = value
        }
    }

    /// Returns the value stored under `key`, or `V`'s zero value when the
    /// key is absent — the same absent-key behavior as a G# map read.
    ///
    /// Lock-free; never blocks writers.
    ///
    /// @param key the key to read.
    /// @returns the stored value, or the zero value of `V` when absent.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Load(key K) V {
        var v V
        if items.TryGetValue(key, out v) {
            return v
        }

        // Absent: fall back to V's zero value. (After a failed TryGetValue
        // the out local is V? under nullable interop flow — MaybeNullWhen —
        // so a fresh zero-valued local is returned instead.)
        var zero V
        return zero
    }

    /// Atomically replaces the value under `key` with `f(current)`, where
    /// `current` is the stored value or `V`'s zero value when the key is
    /// absent. The read-modify-write is atomic with respect to every other
    /// write on this map (`Store`, `Delete`, and other `Update` calls),
    /// which makes `m.Update(k, func(v int32) int32 { return v + 1 })` an
    /// exact concurrent counter.
    ///
    /// `f` runs while the map's write monitor is held: keep it small, and
    /// do not block in it. (Re-entrant writes to the same map from inside
    /// `f` do not deadlock — the monitor is reentrant — but they see the
    /// pre-`Update` state and are almost never what you want.)
    ///
    /// @param key the key to update.
    /// @param f applied to the current value (or zero value) under the
    ///          write monitor; must not be `nil`.
    /// @returns the value produced by `f` and stored.
    /// @exception ArgumentNullException `f` is `nil`.
    func Update(key K, f (V) -> V) V {
        if f == nil {
            throw ArgumentNullException("f")
        }

        lock items {
            let next = f(Load(key))
            items[key] = next
            return next
        }
    }

    /// Removes the entry under `key`, if present.
    ///
    /// @param key the key to remove.
    /// @returns `true` when an entry was removed, `false` when the key was
    ///          absent.
    func Delete(key K) bool {
        lock items {
            var removed V
            return items.TryRemove(key, out removed)
        }
    }

    /// Returns the number of entries.
    ///
    /// Lock-free; never blocks writers. Under concurrent writes the count
    /// is a snapshot that may be stale by the time it is observed.
    ///
    /// @returns the entry count.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Length() int32 {
        return items.Count
    }

    /// Reports whether `key` currently has an entry.
    ///
    /// Lock-free; never blocks writers.
    ///
    /// @param key the key to test.
    /// @returns `true` when the key is present.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Contains(key K) bool {
        return items.ContainsKey(key)
    }

    /// Returns a snapshot slice of the keys present when the snapshot was
    /// taken. Safe under concurrent writes (never throws); keys added or
    /// removed while snapshotting may or may not appear.
    ///
    /// @returns a new slice holding the snapshot keys, in no particular
    ///          order.
    func Keys() []K {
        // List + ToArray: a slice is a fixed CLR array, and the growable
        // shape is `List[T]` + `Add` (ADR-0174 D13 retired `append`).
        var ks = List[K]()
        for k in items.Keys {
            ks.Add(k)
        }

        return ks.ToArray()
    }

    /// Invokes `action` for each entry. Safe under concurrent writes
    /// (never throws): enumeration walks the concurrent backing store, so
    /// entries added or removed while ranging may or may not be visited.
    /// The write monitor is NOT held during `Range` — `action` may write
    /// to this map freely.
    ///
    /// @param action invoked with each key and value; must not be `nil`.
    /// @exception ArgumentNullException `action` is `nil`.
    func Range(action (K, V) -> void) {
        if action == nil {
            throw ArgumentNullException("action")
        }

        var e = items.GetEnumerator()
        while e.MoveNext() {
            action(e.Current.Key, e.Current.Value)
        }
    }
}
