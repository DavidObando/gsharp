# `bench/concurrency` — paired CLR / Go concurrency baseline

Evidence harness for **ADR-0174** (goroutines and channels, wave 2). It exists
to make the ADR's performance claims refutable, and to stop new ones from
being asserted without measurement.

> **Status: baseline plus the Phase 1 runtime.** The Phase-0 spike measured
> *today's* lowering and the CLR primitives the ADR proposes to adopt. ADR-0174
> Phase 1 added two rows over the real `Gsharp.Runtime.Channels` assembly
> (`gs-rendezvous`, `closed-chan`). There is still no G#-*language* side until
> Phases 2–3 land, and the harness is **not** wired into CI. D11 Phase 5 turns
> this into the gated suite.

## Phase 3-4a rows (`ctx-param`, `ctx-asynclocal`, `spawn-noec`, `spawn-ec`)

`ContextAbiCost` measures ADR-0174 decision gates G1/G2: how the ambient
`Context` reaches a suspending call (hidden parameter vs an `AsyncLocal`
read at every level of a 3-deep synchronously-completing chain), and the cost
of flowing `ExecutionContext` into a goroutine spawn. Recorded in ADR-0174
errata 12.

## Layout

| Path | What it is |
| --- | --- |
| `clr/` | C# baseline. Reproduces the exact call sequences the G# emitter produces today (`gs-*` rows), plus the CLR primitives ADR-0174 proposes (`best-*` rows). |
| `go/` | Go baseline for the same scenarios. |

## Running

```sh
# CLR side — Release is mandatory, Debug numbers are meaningless
cd clr && dotnet run -c Release
# --quick skips the 60 s starvation demonstration (a correctness result, not a number)
cd clr && dotnet run -c Release -- --quick

# Go side
cd go && go build -o baseline . && ./baseline
```

Both print `name, ns/op` rows on stdout.

## Methodology requirements

These are not optional. ADR-0174 §D11 makes them normative because ignoring
any one of them produced a wrong conclusion at least once during the original
spike:

1. **Warm up.** Tiered JIT depresses cold CLR numbers by **2–3×**. The CLR
   harness runs three rounds and only round 3 is reportable. A CLR-vs-Go
   comparison taken from round 1 is invalid.
2. **Release build, both sides.**
3. **Multiple process launches.** In-process repetition alone understates
   variance. Report a confidence interval, not a single number.
4. **Pin and record both toolchains and the hardware class.** The reference
   numbers in ADR-0174 are .NET 10.0.11 / Go 1.27.0, Apple silicon, 18 cores.
5. **Separate the two gates.** Within-runtime regression (G# against its own
   last recorded number) is stable and can gate a PR. The G#-vs-Go ratio
   depends on the Go toolchain and the machine and must stay informational.

## Known limits of the current numbers

Carried here so they are not lost when the numbers are quoted:

- **The rendezvous row is the Phase 1 runtime, not emitted G#.** `gs-rendezvous`
  drives two capacity-0 `Chan<int>`s from two tasks with `await SendAsync` /
  `await ReceiveAsync` — the exact shape the Phase 3 lowering emits — so it is
  the honest rendezvous number wave 1 could not produce (`gs-pingpong` remains
  the capacity-1 stand-in for comparison). First same-machine measurement
  (Linux x64, 20 cores, .NET 10.0.11 / Go 1.27.0, round 3 of 3, single
  launch): **`gs-rendezvous` 1.18–1.30 µs/op vs `go-pingpong` 617 ns/op ≈ 2×**.
  The runtime completes waiters with `RunContinuationsAsynchronously = true`
  (a thread-pool hop per hand-off, stack-safe under ping-pong chains); the
  ADR's decision gate G6 measures the synchronous alternative before Phase 5
  sets the budget. Note how machine-dependent the absolute numbers are: the
  same Go program measured 219 ns/op on the ADR's Apple-silicon reference.
- **`closed-chan` is the Phase 1 runtime's closed receive**: `TryReceive` on a
  closed, drained `Chan<T>` takes a lock-free path (`closed` is monotonic and
  the buffer can only drain after close) and measured **0.7 ns/op** vs
  `closed-flag` (BCL `TryRead`) 3.8 ns and `go-closed` 32.5 ns on the same
  machine — the ADR's 382× defect, removed.
- **The `select` row is fast-path only**, over pre-filled channels, and it
  compares G#'s deterministic source-order probing against Go's randomized
  choice. It partly measures the semantic divergence D8 removes. The parking
  path is not measured at all.
- **The spawn row is queueing cost only.** It excludes argument capture,
  state-machine construction, context plumbing, scope registration,
  completion observation, and exception handling.
- **The parked-memory row is suspension depth 1.** ADR-0174 D4 trades one
  state-machine box *per suspended frame* against Go's one growable stack per
  goroutine, so this advantage narrows with depth. Measure depths 1/4/16.

## Notable negative results

Kept deliberately, so they are not re-discovered or re-proposed on intuition:

- **A hand-written Go-style `hchan`** (ring buffer, FIFO waiter queues, pooled
  `IValueTaskSource` waiters) measured **105.8 ns/op — worse** than
  `System.Threading.Channels`' 44.9. The bottleneck is park/unpark and
  scheduler hand-off, not the queue data structure. Rewriting the queue is not
  the lever.
- **Spin-before-park**, added on the theory it would avoid hand-off cost, made
  things *catastrophically* worse (42 µs/op) before being reduced to a small
  budget.
- **Go wins the chunked/SIMD pipeline rows too** (0.7–0.8 ns/op vs 2.3–2.9).
  The original "SIMD lets the CLR beat Go on bulk transport" thesis did not
  survive measurement; these workloads are bandwidth-bound. ADR-0174 D10
  claims chunking as the right *shape* for a G# pipeline, not as a win over
  Go.

## Related

- `docs/adr/0174-goroutines-and-channels-wave-2.md` — the decision this
  harness supports, including the per-scenario budget table (D11).
- `build/generate-quality-dashboard.py` — the existing perf harness whose JSON
  output format and dashboard this suite should feed.
