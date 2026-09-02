# ADR-0158: The G# synchronization story — a Sync library type plus documented interop, not a `synchronized` modifier

- **Status**: Accepted — 2026-08-06
  ([#3209](https://github.com/DavidObando/gsharp/issues/3209); implemented
  in the same change — `src/Sdk/Gsharp.Extensions/Sync/Sync.gs`, pinned by
  `test/Extensions.Tests/SyncMapTests.cs` (behavior + the four successor
  guarantees) and `test/Interpreter.Tests/SyncMapImportEmittedOracleTests.cs`
  (G#-side `import` consumption); the feasibility spike stays untouched as
  evidence at `test/Interpreter.Tests/Adr0158SyncMapSpikeTests.cs`, per the
  ADR-0156/0157 precedent)
- **Date**: 2026-08-06
- **Phase**: Language surface / concurrency ergonomics (ADR-0156 Phase 3
  semantic-alignment follow-up)
- **Related**: [#3209](https://github.com/DavidObando/gsharp/issues/3209)
  (this question), [#3205](https://github.com/DavidObando/gsharp/issues/3205)
  (decided: emitted maps are plain `Dictionary<,>`, not goroutine-safe —
  Go parity), [#3163](https://github.com/DavidObando/gsharp/issues/3163) /
  [#3176](https://github.com/DavidObando/gsharp/issues/3176) (campaign
  tracking), ADR-0002 (concurrency model: Go surface, .NET runtime, Kotlin
  scopes), ADR-0022 (`go`/`chan`/`select` lowering), ADR-0034 (imported CLR
  interop), ADR-0084 (G#-authored `Gsharp.Extensions` packages — the
  Optional precedent), issue [#1885](https://github.com/DavidObando/gsharp/issues/1885)
  (the `lock` statement), issue [#1799](https://github.com/DavidObando/gsharp/issues/1799)
  (the evaluator's implicit map lock, retired with ADR-0156 Phase 3c;
  pre-deletion tests at commit `5cd0d766`),
  [#2485](https://github.com/DavidObando/gsharp/issues/2485) (Swift-style
  actors — open, positioned against below); spike fallout filed as
  [#3303](https://github.com/DavidObando/gsharp/issues/3303) (generic
  `map[K,V]` field NRE) and
  [#3304](https://github.com/DavidObando/gsharp/issues/3304) (`go` rejects
  void operands)

## Context

When ADR-0156 Phase 3c deleted the tree-walking evaluator, its implicit
per-instance map lock (#1799) died with it: a G# `map[K,V]` is a plain
`Dictionary<K,V>` in IL, and concurrent goroutine access is not
goroutine-safe. #3205 decided that interim state deliberately — Go's own
maps are unsynchronized and Go declares concurrent map writes fatal — and
#3209 asks for the first-class successor story. The owner's framing there is
the constraint that matters: G# already has `lock` and full
`System.Threading` / `System.Collections.Concurrent` interop, so **the goal
is ergonomics, not capability**.

Five facts about the language as it exists today frame the answer.

**1. G# already has a synchronization statement.** `lock expr { body }`
(reserved keyword, Go-shaped headerless syntax) is lowered entirely in the
binder — there is no `BoundLockStatement`; `StatementBinder.Loops.cs`
(`BindLockStatement`) evaluates the target once into a synthesized readonly
local, rejects value-type targets (the C# CS0185 rule), and builds
`Monitor.Enter(tmp); try { body } finally { Monitor.Exit(tmp) }` from
imported `System.Threading.Monitor` symbols (#1885). Any new construct that
means "hold a monitor around this region" already has its lowering built.

**2. The interop floor is real, today.** The spike below compiles and runs a
G# program that constructs `ConcurrentDictionary[string, int32]` (after
`import System.Collections.Concurrent`), `TryAdd`s from 24 goroutines, and
reads back with `TryGetValue(k, out v)` — all writes survive, no compiler
change involved. Capability is genuinely not the gap.

**3. The concurrency identity is Go's, and Go's answer is not a modifier.**
ADR-0002 fixed the surface: `go` / `chan T` / `<-` / `select` plus
structured `scope { }` blocks, lowered to `Task.Run` and
`System.Threading.Channels`. Go's doctrine for this exact problem is "share
memory by communicating"; where sharing is unavoidable, Go ships `sync.Map`
— a **method-based library type** (`Store`/`Load`/`Range`), deliberately
without index syntax — plus a race detector. Java's `synchronized` is the
foreign lineage here, and it is the one precedent whose own ecosystem
retreated from it: synchronized collections gave way to
`java.util.concurrent`, and the instance-as-monitor design (any foreign code
can lock your object) is the pitfall #3209 already flags. .NET walked the
same road: `lock(this)`, `SyncRoot`, and `MethodImplOptions.Synchronized`
all moved from guidance to warning over the years, for the same two reasons
— wrong granularity (method-scoped monitors serialize non-conflicting
operations) and false safety (they still cannot make *compound*
check-then-act operations atomic).

**4. Nothing in the corpus wants this.** Across `samples/*.gs` and the
cs2gs corpus there are **zero** uses of `lock`, `Monitor`, `Mutex`,
`Interlocked`, or `ConcurrentDictionary`, and **no program shares a map
across goroutines**. The programs that do share state across goroutines
(`GoScope.gs`, `PortScan.gs`) share buffered channels joined by `scope` —
the idiom working as designed. The triggering artifact for #3209 was a test
suite pinning evaluator internals, not user demand.

**5. Syntax would be the cheap part.** For completeness: a `synchronized`
(or `sync`) modifier would slot into the existing contextual-modifier loop
in `Parser.Declarations.cs` / `Parser.Members.cs` exactly like `data`,
`partial`, `inline`, and `unsafe` did — no new reserved keyword needed. The
argument against it is not implementation cost; it is that the construct is
the wrong shape (fact 3) for a need that does not exist (fact 4) and is
already served (facts 1–2), while a plausible future language surface for
shared state — actors, #2485, open — would supersede it.

## Decision

**Ship the synchronization story as library plus documentation, and add no
language surface:**

1. **`Gsharp.Extensions.Sync`** — a G#-authored SDK package (the ADR-0084
   Optional/Sequences precedent) whose first type is **`SyncMap[K, V]`**,
   G#'s `sync.Map` analog: a generic class wrapping a private
   `ConcurrentDictionary[K, V]`, method-based API, no literal or index
   syntax:

   ```gsharp
   import Gsharp.Extensions.Sync

   var m = SyncMap[string, int32]()
   m.Store("k", 1)
   m.Update("k", func(v int32) int32 { return v + 1 })  // atomic RMW
   let v = m.Load("k")      // zero value when absent — map-read parity
   m.Range(func(k string, v int32) { ... })
   ```

   Shipped surface (`Sync.gs`): `Store(key, value)`, `Load(key) V`
   (zero value when absent, mirroring G# map reads — which lower to
   `TryGetValue`, not `get_Item`), `Update(key, f) V` (atomic
   read-modify-write, returns the stored result), `Delete(key) bool`,
   `Length() int32` (**renamed from `Len()` by ADR-0174 D16, landed** — `Len` was a
   Go spelling with a CLR incumbent, and ADR-0174 retires that whole family;
   the method shape and the stale-snapshot contract argued for below are
   unchanged), `Contains(key) bool`, `Keys() []K` (snapshot),
   `Range(action)`. Reads and enumeration are lock-free on the concurrent
   backing; the three writes serialize on the private backing instance as
   hidden monitor — that is what makes `Update` atomic against *all*
   writes, not just other `Update`s. The backing dictionary is private and
   never leaked — the hidden-monitor discipline #3209 requires — and the
   nullable-interop and function-literal papercuts the spike hit stay
   *inside* the library, which is itself an ergonomics argument for
   shipping it rather than documenting the raw pattern.

   The method-based API is a deliberate semantic choice, not a limitation:
   Go's `sync.Map` has no index syntax either, because `m[k] = m[k] + 1`
   *looks* atomic and is not. `Update` exists precisely because per-call
   locking cannot express compound operations through indexer sugar.

2. **Documentation** teaching, in order: the idiom (goroutines + channels
   + `scope` — "share memory by communicating"), `lock` for protecting
   arbitrary state, the CLR interop menu (`ConcurrentDictionary`,
   `Interlocked`, `ReaderWriterLockSlim`, `Mutex`/`SemaphoreSlim`), and
   `SyncMap` for the shared-map case — the "documented interim guidance"
   leg of #3209, kept even after the library lands. Shipped as
   `docs/concurrency.md` (engineering-side) plus the user-facing website
   pages: a "Synchronization and shared state" section in
   `website/docs/guide/concurrency.md`, a `Gsharp.Extensions.Sync` API
   reference in `website/docs/ref/standard-library.md` (with the map
   non-guarantee noted in its Maps section), and the
   `website/docs/extensions/go-concurrency.md` shared-map note updated to
   point at `SyncMap` instead of at #3209.

3. **Plain `map[K, V]` stays unsynchronized, and concurrent access stays
   undefined behavior, documented** — #3205's stance becomes the permanent
   spec position. No Go-style runtime fault: `Dictionary<,>` already
   surfaces a best-effort corruption exception (the spike's mutant runs
   show it), but *guaranteeing* detection would mean wrapping every map
   operation in every compiled program with checking — a tax on all code
   for a race no corpus program can currently hit, and a divergence from
   the "map is a plain `Dictionary`" interop contract. A debug-only checked
   map remains available as future work if demand appears.

4. **No `synchronized` modifier**, now or as a follow-up — and the retired
   #1799 guarantees return as `SyncMap` guarantees (the spike tests are
   their successors), attached to the type that can actually honor them.

### The retired Issue1799 guarantees, restated for their successor

| Evaluator-era guarantee (deleted at `5cd0d766`) | Successor (attaches to `SyncMap`, not `map`) |
|---|---|
| N goroutines writing distinct keys: all writes survive | Same, exact (spike: 24 goroutines, sum 300/300) |
| Racy `m[k] = m[k] + 1`: never corrupts, value in range | **Stronger**: `Update` is atomic — exactly N increments (spike: 50/50, every run) |
| Enumeration while writing: never throws | Same, via `Range` (spike: 30 stress runs) |
| `len` / `ContainsKey` / `Keys` under write load: never throws | Same, via `Len` / `Contains` / `Keys()` (spike: 30 stress runs) |

Plain `map[K, V]` carries none of these — that is #3205, unchanged.

### Representation and magic — map vs SyncMap

Two owner-settled decisions bound this design's representation choices, and
they are two faces of one rule.

**Plain `map[K, V]` stays a compiler-known ("magic") type with `Dictionary`
identity — a library `Map[K, V]` was considered and rejected.**

- **Identity is the interop superpower.** A G# `map[K, V]` *is* a
  `Dictionary<K, V>`: it flows directly into every BCL and C# API that
  takes one, comes back unchanged, and makes cs2gs's `Dictionary`→`map`
  translation trivially correct. A wrapper type would trade that away for
  nothing — either it leaks its backing (no encapsulation gained) or it
  interposes on every boundary crossing (friction everywhere).
- **Zero-runtime-dependency.** A program that uses maps needs only the
  BCL. A library-defined map would make every G# program depend on
  `Gsharp.Extensions` and deepen the SDK bootstrap cycle (`Gsharp.Extensions`
  itself is compiled by a bootstrap that exists precisely because an
  assembly cannot reference itself while being built).
- **Precedent.** Go keeps `map` intrinsic and ships `sync.Map` in a
  package; languages with map *syntax* keep the syntactic type intrinsic.
- **The bug-factory concern has a better answer.** The intrinsic's magic
  plumbing has produced real bugs (#3301, and this campaign's #3303), but
  the fix is consolidating the emit surface — the symbolic-MemberRef
  funnel PR [#3306](https://github.com/DavidObando/gsharp/pull/3306)
  landed for #3301 — not changing representation. If an ergonomic method
  surface on maps is ever wanted, extension functions provide it without
  touching representation.

**`SyncMap` is deliberately NOT magic — the inverse of the same
principle.** A type earns compiler magic only when it carries syntax the
compiler must bind, and `SyncMap`'s design rejects syntax on purpose:

- **Index syntax on a concurrent map is a lie.** `sm[k] = sm[k] + 1`
  looks atomic and races; the method API *is* the safety contract, with
  atomicity boundaries visible at every call site. `ConcurrentDictionary`'s
  own history makes the point: it has an indexer, but its real API is
  `GetOrAdd`/`AddOrUpdate`/`TryUpdate`.
- **The valuable operations are method-shaped and want to grow.**
  `Update` today; `GetOrAdd`, compare-and-swap, richer snapshots later —
  in library releases, not compiler releases.
- **Concurrency semantics belong to library-versioned doc contracts.**
  Range's snapshot-vs-live behavior, `Keys` timing, and memory-model notes
  can evolve with the library; baked into language syntax they would be
  spec commitments requiring compiler releases to change.
- **Identity would be a bug here.** If the backing `ConcurrentDictionary`
  were reachable, callers could bypass `Update`'s atomicity or lock the
  monitor from outside (the Java pitfall above). Encapsulation is
  load-bearing — the exact property that would be wrong for `map` is the
  one `SyncMap` cannot live without.
- **Zero compiler cost, proven.** The spike and the shipped implementation
  required no compiler change at all; a magic `syncmap` would buy a second
  copy of the intrinsic-plumbing maintenance tax (#3301/#3303's class)
  for negative value.

**The composed rule:** syntax-bearing types are compiler-known and
identity-transparent to their BCL backing (`map` ≡ `Dictionary`);
concurrency types are library-defined, method-shaped, and
encapsulation-opaque (`SyncMap` hides its `ConcurrentDictionary`).

## Evidence — feasibility spike

`test/Interpreter.Tests/Adr0158SyncMapSpikeTests.cs` (trait
`Category=Adr0158Spike`, run via
`dotnet test test/Interpreter.Tests --filter "FullyQualifiedName~Adr0158"`)
proves the mechanism end-to-end with **zero product changes**, over real
emitted execution (`test/Shared/EmittedOracle`). The prototype `SyncMap` is
written in G# *inside the test source* using only today's surface: a class
with a private map field as hidden monitor, `lock` statements,
function-typed parameters for `Update`, slice/`append` for `Keys`.

All 6 tests green; suite wall time ~1 s (the stress tests each recompile
and rerun the emitted program 30–40 times under `Parallel.For`):

| Test | Result |
|---|---|
| 24 goroutines, distinct keys (Issue1799-A successor) | sum exactly 300 — all writes survive |
| 50 goroutines incrementing one key, × 40 runs (Issue1799-B successor) | exactly 50 every run — atomic `Update`, stronger than the evaluator's racy guarantee |
| `Range` while 16 writers store, × 30 runs (Issue1799-C successor) | never throws |
| `Len`/`Contains`/`Keys` under write load, × 30 runs (Issue1799-D successor) | never throws |
| Interop floor: raw `ConcurrentDictionary` from G#, 24 goroutines | all writes survive — the docs-guidance leg needs no compiler work |
| Generic shape: `GenericSyncMap[K, V any]` over a `ConcurrentDictionary[K, V]` field, two closed instantiations | compiles and runs — **the shipped generic library type needs zero compiler changes** |

**Discrimination witness (ADR-0154, mutant form).** Deleting the `lock`
statements from the prototype (`sed 's/lock items {/{/'` — the
unsynchronized mutant) breaks the guarantees loudly. Across two recorded
mutant runs: the increment count collapsed to values as low as **1**
(observed result sets `[1, 1, 1, 49, 26, …]`, `[43, 15, 33, 29, 44, …]`
instead of fifty 50s), distinct-key writes were lost, and both enumeration
tests died with the CLR's *"Operations that change non-concurrent
collections must have exclusive access. A concurrent update was performed on
this collection and corrupted its state."* Which guarantees fail varies
per run with scheduling — all four failed at least once, none ever fails
with the locks in place.

**Spike fallout, filed.** Two real gaps surfaced and are now issues rather
than footnotes:

- [#3303](https://github.com/DavidObando/gsharp/issues/3303): a generic
  class with a `map[K, V]` field over its own type parameters compiles but
  the `map[K, V]{}` literal never reaches the field (NRE at first use), and
  `map[K, V] != nil` does not bind. This is why the recommended backing is
  `ConcurrentDictionary[K, V]` — which the spike shows works generically
  today — rather than a locked plain map; it is also the better backing on
  merits (lock-free reads, safe enumeration).
- [#3304](https://github.com/DavidObando/gsharp/issues/3304): `go f()`
  rejects void-returning operands ("Expression must have a value."), which
  is why every goroutine in the corpus carries a dummy `return 0`.
  Unrelated to synchronization, but it is the largest concurrency-ergonomics
  papercut the spike actually hit — worth fixing regardless of this ADR's
  outcome.

### Implementation evidence (same change)

The shipped `SyncMap` (`src/Sdk/Gsharp.Extensions/Sync/Sync.gs`, ~200
lines of documented G#) compiles through the normal bootstrap build with
no compiler changes, confirming the spike's central claim. Its pins:

- `test/Extensions.Tests/SyncMapTests.cs` — 17 tests directly against the
  compiled assembly with real threads: unit coverage of every method plus
  the four successor guarantees (64 distinct keys × 200 runs; 200
  concurrent `Update` increments × 100 runs, exact every run; `Update`
  atomic against interleaved `Store`/`Delete` churn; `Range` and
  `Len`/`Contains`/`Keys` looped against 8 continuous writer tasks). Also
  pins the hidden-monitor rule structurally (no public fields, no
  dictionary-typed properties).
- `test/Interpreter.Tests/SyncMapImportEmittedOracleTests.cs` — G#-side
  `import Gsharp.Extensions.Sync` consumption through real emitted
  execution: full-surface smoke plus the #3205 repro shape (50 goroutines
  bumping one key in a `scope`), exactly 50 every run.
- **Product-mutant witnesses (ADR-0154)**, run against the real library:
  stripping `Sync.gs`'s `lock` statements fails both increment guarantees
  (observed 72/200 and 1/200); swapping the `ConcurrentDictionary` backing
  for a plain `Dictionary` fails both enumeration guarantees with the
  CLR's "Collection was modified" exception. Each guarantee is killed by
  the mutation it exists to police.

Two boundary notes recorded while implementing, both stays-inside-the-
library per the ergonomics argument above: the `append` builtin is gated
behind `Gsharp.Extensions.Go` (GS0317), so `Keys()` builds its snapshot
via `List[K]` + `ToArray`; and across the imported-assembly boundary
`Keys()`'s `[]K` binds as a CLR array (`.Length`, not `len`) — noted in
the consumption test.

## Consequences

- The shared-map question gets a first-class, teachable answer —
  `import Gsharp.Extensions.Sync`, use `SyncMap` — with zero new grammar,
  binder, emit, or spec surface, and the retired evaluator-era guarantees
  come back attached to a type that can honor them under the one remaining
  engine.
- G# stays aligned with **both** parents at once: Go (maps unsynchronized;
  the blessed shared map is a method-based library type) and .NET
  (`ConcurrentDictionary` is the platform primitive; a G# `SyncMap` handed
  across the interop boundary is an ordinary class wrapping one).
- The actor horizon (#2485) stays clean. If actors ever land, they become
  the language-surface answer for owned mutable state, and `SyncMap`
  remains a useful leaf type — whereas a `synchronized` modifier shipped
  now would be a second, weaker, permanent language mechanism the actor
  design would have to coexist with and teach around.
- Cost: one more `Gsharp.Extensions` package to maintain (small, and the
  pattern is established); `SyncMap`'s contract (zero-value `Load`,
  snapshot `Keys`, atomicity of `Update`) needs package-doc treatment; users
  wanting other synchronized shapes (sets, queues) drop to the documented
  interop menu until demand justifies more types.
- Nothing is foreclosed. A future compiler-bound `syncmap[K, V]` sugar, a
  checked debug map, or actors can all be layered on later without breaking
  the library API; the modifier path remains *possible* — this ADR's claim
  is that it should stay untaken.

## Alternatives considered

### A `synchronized` / `sync` modifier on classes, methods, or instances

The #3205 sketch. Mechanically cheap: contextual-modifier parsing precedent
(`data`, `partial`, `inline`), and the `lock` lowering (#1885) already
builds the monitor discipline — a G# version would lock a private
synthesized monitor field, never object identity, avoiding Java's
public-monitor mistake. Rejected on the merits anyway:

- **Wrong lineage for this language.** ADR-0002 made the Go surface G#'s
  identity; Go pointedly has no monitor modifier, and its own shared-map
  answer is a library type. A Java-shaped modifier would be the first
  concurrency construct in G# with no ancestor in either Go or modern C#.
- **Wrong granularity, false safety.** Method-scoped monitors serialize
  operations that don't conflict and still fail the operations that matter
  — `if !m.Contains(k) { m.Store(k, v) }` is a race under per-method
  locking no matter how the methods are marked. Java's synchronized
  collections and .NET's `SyncRoot`/`Synchronized` wrappers were abandoned
  by their own platforms for exactly this; `SyncMap.Update` exists because
  compound atomicity must be expressed in the API, not sprinkled on with a
  keyword.
- **Permanent spec surface for zero demonstrated demand** (corpus: zero
  `lock`, zero shared maps), purchased one campaign after ADR-0156/0157
  spent heavily to *shrink* divergence and surface area.
- **A dead-end investment against the actor horizon.** #2485 is open and is
  the credible future language answer to shared mutable state. Betting
  language surface now on the monitor model prejudges that design in the
  wrong direction (Swift and Kotlin both went isolation/actors, not
  synchronized classes).

### A compiler-bound `syncmap[K, V]` builtin type (the `map`/`chan` pattern)

`MapTypeSymbol`/`ChannelTypeSymbol` show the recipe: bind a keyworded type
to a chosen CLR backing. Rejected as premature: it buys literal/index sugar
at the cost of new type-symbol, parser, binder, and emit surface — and
index sugar on a concurrent map is an anti-feature (it invites
`m[k] = m[k] + 1`, the exact racy idiom the type exists to kill; Go's
`sync.Map` refuses index syntax deliberately). Revisitable later as pure
sugar over the library type if usage ever justifies it.

### Emit synchronized accessors on plain `map` (restore the implicit lock)

Already rejected by #3205: it taxes every map in every program, diverges
from both Go semantics and the `Dictionary<,>` interop contract, and still
doesn't make compound operations atomic — the evaluator's lock was an
implementation artifact, not a keepable promise.

### Go-style runtime fault on concurrent map access

Guaranteed detection requires checked wrappers around every map operation
program-wide; today's behavior (undefined, with `Dictionary`'s best-effort
corruption exception, which the mutant runs show does fire under enumeration
races) matches Go's contract at zero cost. Kept as possible future
debug-mode work; the spec records "not goroutine-safe; behavior undefined."

### Actors now (#2485)

The right long-term direction and deliberately *not* prejudged here — but
the wrong scope for #3209: an actor design (isolation rules, reentrancy,
executor mapping onto the Task pool, interop with `scope`/channels) is a
multi-ADR effort and still would not answer "I have a map shared by two
goroutines today" without one. The library type serves that need now and
survives an actor future as an ordinary type.

### Documentation only (pure v0)

Viable — capability exists — but it leaves the retired #1799 guarantees
with no successor tests, no idiomatic spelling for the one shape Go itself
found common enough to bless, and pushes the nullable-interop/`out`-param
papercuts the spike hit onto every user who follows the docs. The library
type is small, spike-proven, and carries the docs page with it.
