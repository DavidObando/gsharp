# Concurrency and synchronization in G#

Engineering-side reference for G#'s synchronization story, recorded with
ADR-0158 (issue #3209). User-facing guidance lives on the website:
[guide/concurrency](../website/docs/guide/concurrency.md),
[extensions/go-concurrency](../website/docs/extensions/go-concurrency.md),
and the [standard-library reference](../website/docs/ref/standard-library.md).

## The idiom: share memory by communicating

G#'s concurrency surface is Go-shaped over the .NET runtime (ADR-0002,
ADR-0022): `go f(args)` lowers to `Task.Run`, `chan T` to
`System.Threading.Channels.Channel<T>`, `select` orchestrates channel
operations, and structured `scope { ... }` blocks join everything they own.
The first answer to "how do goroutines share state" is the same as Go's:
don't — pass values through channels, and let `scope` own the joins. Every
concurrency sample in the repo works this way.

## `lock` — protecting arbitrary shared state

When sharing is unavoidable, G# has a `lock` statement (issue #1885):

```gsharp
lock guard {
    // critical section
}
```

`lock expr { body }` is binder-lowered to the classic
`Monitor.Enter(tmp); try { body } finally { Monitor.Exit(tmp) }` shape with
the target evaluated once into a synthesized local; value-typed targets are
rejected (the C# CS0185 rule). Lock on a **private object that never leaks**
— never on `this` or any value foreign code can reach (the Java
synchronized-on-instance pitfall).

## The interop menu

Everything in `System.Threading` and `System.Collections.Concurrent` is one
import away (ADR-0034); capability was never the gap (ADR-0158 records the
measured proof). Commonly useful:

| Need | Reach for |
| --- | --- |
| Concurrent map, lock-free reads | `ConcurrentDictionary[K, V]` (`import System.Collections.Concurrent`) |
| Atomic counters / flags | `Interlocked` (`import System.Threading`) |
| Many readers, few writers | `ReaderWriterLockSlim` |
| Async-friendly mutual exclusion / throttling | `SemaphoreSlim` |
| Cross-process mutual exclusion | `Mutex` |

## Maps are not goroutine-safe — `SyncMap` is the blessed shape

A G# `map[K,V]` **is** a plain `Dictionary<K,V>` (identity, no wrapper —
see ADR-0158's representation section). It has no implicit
synchronization; concurrent goroutine access is **undefined behavior**,
matching Go's "maps are not safe for concurrent use" (#3205). There is no
runtime concurrent-access fault; the CLR may surface a best-effort
corruption exception, but nothing is guaranteed.

For a map that is *meant* to be shared, use the G#-authored
`Gsharp.Extensions.Sync.SyncMap[K, V]`
(`src/Sdk/Gsharp.Extensions/Sync/Sync.gs`, ADR-0158):

```gsharp
import Gsharp.Extensions.Go
import Gsharp.Extensions.Sync

func bump(m SyncMap[string, int32]) int32 {
    m.Update("hits", func(v int32) int32 { return v + 1 })  // atomic
    return 0
}

func run() int32 {
    var m = SyncMap[string, int32]()
    scope {
        for var i = 0; i < 50; i++ {
            go bump(m)
        }
    }

    return m.Load("hits")   // exactly 50
}
```

Design contract (details in the type's doc comments and
`test/Extensions.Tests/SyncMapTests.cs`):

- **Method-based, no index syntax** — `m[k] = m[k] + 1` on a shared map
  looks atomic and races; compound read-modify-write is spelled `Update`
  and is atomic against every other write.
- **Reads and enumeration are lock-free** (`Load`, `Length`, `Contains`,
  `Keys`, `Range`) on the private `ConcurrentDictionary` backing; writes
  (`Store`, `Delete`, `Update`) serialize on a hidden monitor that never
  leaks.
- **Absent-key `Load` returns `V`'s zero value**, mirroring a G# map read.
- The guarantees carried by the retired evaluator-era implicit map lock
  (#1799, deleted with ADR-0156 Phase 3c) live on here: distinct-key
  concurrent writes all survive, `Update` counts are exact, and
  enumeration/size/membership reads never throw under write load.

## History

- ADR-0002 — concurrency model (Go surface, .NET runtime, Kotlin scopes).
- ADR-0022 — `go`/`chan`/`select` lowering targets.
- #1799 → #3205 → #3209 / ADR-0158 — the evaluator's implicit map lock,
  its retirement with the emitted-only engine, and the `SyncMap` successor.
