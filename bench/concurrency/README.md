# `bench/concurrency` — paired CLR / Go concurrency baseline

Evidence harness for **ADR-0174** (goroutines and channels, wave 2). It exists
to make the ADR's performance claims refutable, and to stop new ones from
being asserted without measurement.

> **Status: the G# side and the runner exist; no budget has been measured.**
> The Phase-0 spike measured *today's* lowering and the CLR primitives the ADR
> proposes to adopt; Phase 1 added two rows over the real
> `Gsharp.Runtime.Channels` assembly. Phase 5-2 adds the missing half: eight
> paired scenarios written in **G#**, a registry, a runner with the two gates,
> and a nightly workflow.
>
> **Every median in `baseline.json` is `null`, deliberately.** A budget that was
> not measured is worse than no budget, because it reads as evidence. The gate
> is armed by the first nightly runs, and `target_status` stays `provisional`
> until a ratio has met its target on three separate nights on the same
> hardware class (ADR-0174 P5-3).

## Phase 3-4a rows (`ctx-param`, `ctx-asynclocal`, `spawn-noec`, `spawn-ec`)

`ContextAbiCost` measures ADR-0174 decision gates G1/G2: how the ambient
`Context` reaches a suspending call (hidden parameter vs an `AsyncLocal`
read at every level of a 3-deep synchronously-completing chain), and the cost
of flowing `ExecutionContext` into a goroutine spawn. Recorded in ADR-0174
errata 12.

## Layout

| Path | What it is |
| --- | --- |
| `gsharp/Bench.gs` | **The G# side.** Eight scenarios in the language itself, three in-process warm-up rounds, one `<name> ns_per_op <float>` line each. `GSHARP_BENCH_SCENARIO` runs one. |
| `scenarios.json` | The registry: which G# scenario pairs with which Go row, and what each one measures. |
| `baseline.json` | The recorded medians, ceilings and Go ratios. Written only by `--update-baseline`, never by hand. |
| `aot/` | The NativeAOT measurement mode. Compiles no G# and holds no benchmark logic: it borrows the SDK's `PublishAot` pipeline and points ILC at the assembly gsc already emitted, so the AOT and JIT rows run byte-identical IL. |
| `clr/` | C# baseline. Reproduces the exact call sequences the G# emitter produces today (`gs-*` rows), plus the CLR primitives ADR-0174 proposes (`best-*` rows). Kept as the spike reference now that the G# side exists. |
| `go/` | Go baseline for the same scenarios. |

## Running

```sh
# The paired run: builds the G# program, launches both sides several times,
# reports medians with a bootstrap confidence interval, and checks the gate.
python3 build/run-concurrency-bench.py --go --aot --check-baseline bench/concurrency/baseline.json

# Drop --aot while iterating: it adds a NativeAOT publish (minutes) per run.
# One scenario, fewer launches, while iterating
python3 build/run-concurrency-bench.py --scenario rendezvous --launches 3

# Record what was measured. Refuses to loosen a ceiling without a stated reason.
python3 build/run-concurrency-bench.py --go --update-baseline bench/concurrency/baseline.json

# Check the harness still hangs together (this runs on every PR)
python3 build/verify-concurrency-bench.py --smoke

# CLR spike reference — Release is mandatory, Debug numbers are meaningless
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

1. **Warm up, and pin the JIT tier.** Tiered JIT depresses cold CLR numbers by
   **2–3×**. The harness runs three rounds and only round 3 is reportable — but
   rounds are not sufficient on their own. The runtime's call-counting delay is
   100 ms and restarts on every new JIT compilation, so a bench process that
   keeps first-calling methods can exit before counting ever begins: the
   scenario's own loop gets promoted by on-stack replacement while every method
   it calls stays at Tier0. That is a real measurement this harness reported for
   weeks, and it moved `select-ready` by **3.4×** between launches of an
   unchanged binary (issue #3901). The runner therefore sets
   `DOTNET_TC_CallCountingDelayMs=0` for the JIT mode. Do not remove it, and do
   not substitute `DOTNET_TieredCompilation=0`, which also discards dynamic PGO.
2. **Release build, both sides.**
3. **Multiple process launches.** In-process repetition alone understates
   variance. Report a confidence interval, not a single number.
4. **Pin and record both toolchains and the hardware class.** The reference
   numbers in ADR-0174 are .NET 10.0.11 / Go 1.27.0, Apple silicon, 18 cores.
5. **Measure the G# side in both modes.** `--aot` adds a NativeAOT row beside
   the pinned-tier JIT row. Neither is "the" number: the JIT row is what a
   deployed G# program does, the AOT row is what the language does once
   compilation is out of the way, and it is the only mode that compares
   like-for-like with Go's ahead-of-time binary. Which one wins differs per
   scenario **and per machine** — AOT takes the parking rows on a 20-core
   workstation and loses most rows on the 4-vCPU CI runner — which is exactly
   why reporting one alone misleads. Each carries its own ceiling in
   `baseline.json`; compare a row only against runs of the same hardware class.
6. **Gate on a machine whose identity you know; report everywhere else.**
   The recorded medians are one named workstation's numbers, aggregated from
   three full runs that agreed to 0.5-3.3% per scenario. The same three runs on
   GitHub's hosted runners disagreed by **58-205%**, and a baseline seeded from
   one of them would have marked seven of eight scenarios regressed on the other
   two — clearing all three of the gate's conditions, which is exactly the
   false-failure mode that gets a gate switched off. A hosted runner is a shared
   VM of unspecified SKU, and until recently the hardware key could not tell two
   SKUs apart. The nightly therefore runs three passes, aggregates them, and
   reports; it does not fail.
7. **Separate the two gates.** Within-runtime regression (G# against its own
   last recorded number) is stable and can gate a PR. The G#-vs-Go ratio
   depends on the Go toolchain and the machine and must stay informational.
   The runner enforces this: a scenario fails only when its median is above the
   recorded ceiling **and** the confidence intervals are disjoint **and** the
   hardware class matches. Any one of those alone produces false failures often
   enough to get the gate switched off, which is the real failure mode.

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
