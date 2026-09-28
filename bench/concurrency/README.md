# `bench/concurrency` — paired CLR / Go concurrency baseline

Evidence harness for **ADR-0174** (goroutines and channels, wave 2). It exists
to make the ADR's performance claims refutable, and to stop new ones from
being asserted without measurement.

> **Status:** the harness has fourteen G# scenarios, seven Go-paired rows, and a
> historical named-workstation baseline. The baseline predates the current
> comparison fingerprint and remains report-only until that same machine
> records three complete runs with the current methodology. Hosted-runner
> nightlies also report rather than gate.
>
> `target_status` remains `provisional` until a ratio meets its target on three
> separate qualifying runs on the same hardware class (ADR-0174 P5-3).

## Phase 3-4a rows (`ctx-param`, `ctx-asynclocal`, `spawn-noec`, `spawn-ec`)

`ContextAbiCost` measures ADR-0174 decision gates G1/G2: how the ambient
`Context` reaches a suspending call (hidden parameter vs an `AsyncLocal`
read at every level of a 3-deep synchronously-completing chain), and the cost
of flowing `ExecutionContext` into a goroutine spawn. Recorded in ADR-0174
errata 12.

## Layout

| Path | What it is |
| --- | --- |
| `gsharp/Bench.gs` | **The G# side.** Fourteen scenarios in the language itself, 240 cheap call-counted warm-up entries, then one measured `<name> ns_per_op <float> ... checksum <integer>` line each. `GSHARP_BENCH_SCENARIO` runs one. |
| `scenarios.json` | The registry: which G# scenario pairs with which Go row, and what each one measures. |
| `baseline.json` | The recorded medians, ceilings and Go ratios. Written only by `--update-baseline`, never by hand. |
| `aot/` | The NativeAOT measurement mode. Compiles no G# and holds no benchmark logic: it borrows the SDK's `PublishAot` pipeline and points ILC at the assembly gsc already emitted, so the AOT and JIT rows run byte-identical IL. |
| `clr/` | C# baseline. Reproduces the exact call sequences the G# emitter produces today (`gs-*` rows), plus the CLR primitives ADR-0174 proposes (`best-*` rows). Kept as the spike reference now that the G# side exists. |
| `go/` | Go baseline for the same scenarios. |

## Running

```sh
# The gate uses three whole runs, matching the baseline's interval method.
for pass in 1 2 3; do
  python3 build/run-concurrency-bench.py --go --aot \
    --json "out/concurrency-$pass.json"
done
python3 build/run-concurrency-bench.py \
  --from-json out/concurrency-1.json \
  --from-json out/concurrency-2.json \
  --from-json out/concurrency-3.json \
  --check-baseline bench/concurrency/baseline.json

# Drop --aot while iterating: it adds a NativeAOT publish (minutes) per run.
# One scenario, fewer launches, while iterating
python3 build/run-concurrency-bench.py --scenario select-ready --launches 3 \
  --json out/select-ready.json

# Record that same aggregate. Refuses to loosen a ceiling without a reason.
python3 build/run-concurrency-bench.py \
  --from-json out/concurrency-1.json \
  --from-json out/concurrency-2.json \
  --from-json out/concurrency-3.json \
  --update-baseline bench/concurrency/baseline.json

# Check the harness still hangs together (this runs on every PR)
python3 build/verify-concurrency-bench.py --smoke

# CLR spike reference — Release is mandatory, Debug numbers are meaningless
cd clr && dotnet run -c Release
# --quick skips the 60 s starvation demonstration (a correctness result, not a number)
cd clr && dotnet run -c Release -- --quick

# Go side
cd go && go build -o baseline . && ./baseline
```

The G# and Go witnesses print `name`, `ns/op`, and checksum fields on stdout.
The older CLR spike retains its legacy `name` and `ns/op` output.

## Methodology requirements

These are not optional. ADR-0174 §D11 makes them normative because ignoring
any one of them produced a wrong conclusion at least once during the original
spike:

1. **Warm up, and pin the JIT policy.** Tiered JIT depresses cold CLR numbers
   by **2–3×**. The G# program makes 240 cheap call-counted entries into each
   selected scenario, waits for promotion to install, then runs one measured
   round. Current .NET terminology calls the final optimized dynamic-PGO
   version Tier1; an intermediate instrumented tier can require another call
   threshold, but there is no official Tier2 contract. The runner pins the
   current 30-call threshold explicitly. The runtime's default call-counting
   delay is 100 ms and restarts on every new
   JIT compilation, so a bench process that keeps first-calling methods can exit
   before counting ever begins: the scenario's own loop gets promoted by
   on-stack replacement while every method it calls stays at Tier0. That is a
   real measurement this harness reported for weeks, and it moved
   `select-ready` by **3.4×** between launches of an unchanged binary (issue
   #3901). The runner therefore sets
   `DOTNET_TieredCompilation=1`, `DOTNET_TieredPGO=1`,
   `DOTNET_TC_CallCountingDelayMs=0`, and
   `DOTNET_TC_CallCountThreshold=30` for the JIT mode, after removing inherited
   `DOTNET_*` / `COMPlus_*` tier and JIT overrides. Do not substitute
   `DOTNET_TieredCompilation=0`, which also discards dynamic PGO.
   Paired Go launches use their existing three unreported warm-up rounds; a
   scoped run warms only the matching Go row. The `go-park` memory probe is
   explicit-only and never runs in those rate warm-ups.
2. **Release build, both sides.**
3. **Multiple process launches.** In-process repetition alone understates
   variance. Report a confidence interval, not a single number. JSON retains
   `launch_samples_ns` for every row; aggregation retains those samples and the
   per-run medians instead of collapsing the evidence to one statistic.
4. **Pin and record both toolchains and the hardware class.** The reference
   numbers in ADR-0174 are .NET 10.0.11 / Go 1.27.0, Apple silicon, 18 cores.
   Every JSON result also records the runner and benchmark-definition hashes,
   built-artifact hashes, git revision/dirty state, OS/kernel, CPU model and
   affinity, runtime versions and effective runtime settings,
   governor/scaling driver or power source, and start/end load and frequency
   samples. These are observations, not requests to change a host's governor.
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
8. **Compare only like methodology.** Run JSON carries a comparison key over
   the scenario scope, modes, launch count/order, warm-up, JIT settings,
   benchmark definition, host/power state and toolchains. Whole-run aggregation
   additionally requires identical build hashes. Different keys are rejected;
   an older baseline without a comparison key is reported but cannot gate until
   it is re-recorded. A single run whose environment changed remains loadable
   for diagnosis, but cannot aggregate, update a baseline, or gate. When Go is
   requested, JIT/AOT/Go launch order rotates on each sample so a warming or
   drifting host cannot consistently favor one side. The launch count must
   complete whole rotation cycles; the default six launches balances both the
   two-mode and three-mode forms.
   A baseline update and its checks require three full `--go --aot` runs
   aggregated with `--from-json`, without `--scenario`; a partial or single run
   may report, but cannot relabel untouched rows or gate with a different
   interval method.

   The hosted nightly is deliberately report-only and may lack an observable
   power identity. It uses `--allow-incomparable-aggregate` to retain a
   clearly-marked aggregate for diagnosis; that flag never makes the result
   baseline-comparable, and baseline update/check logic remains report-only.
9. **Validate counted work where a checksum is declared.** Every measured
   launch must emit a stable checksum. Paired JIT, NativeAOT, and Go rows must
   agree exactly before a ratio is reported. The native-slice chunk pairs use
   fresh backing arrays, capacity-64 channels, identical indexed filling,
   exact tail lengths, and the same element-sum checksum. CLR-array chunk rows
   remain G#-only controls. Fresh and recycled ownership policies require
   separate rows rather than an unlabelled mixed comparison.

## Known limits of the current numbers

Carried here so they are not lost when the numbers are quoted:

- **`rendezvous` is G#-only; `pingpong` is the paired row.** Rendezvous counts
  one hand-off, while ping-pong counts a two-handoff round trip. Comparing them
  would introduce a 2× denominator error.
- **`select-ready` is G#-only; `select-stream` is the paired row.**
  `select-ready` measures four operations around an always-ready randomized
  select. `select-stream` measures one receive against a producer and mixes
  ready and parked paths. `select-park` separately isolates registration and
  parking.
- **The spawn row remains a narrow empty-body spawn-plus-join shape.** It
  excludes argument capture,
  state-machine construction, context plumbing, scope registration,
  completion observation, and exception handling.
- **The parked-memory row is suspension depth 1.** ADR-0174 D4 trades one
  state-machine box *per suspended frame* against Go's one growable stack per
  goroutine, so this advantage narrows with depth. Measure depths 1/4/16.
- **Chunk rows are fresh/fresh controls, not pooling evidence.** The paired
  native-slice rows align descriptor transport, payload width, channel
  capacity, indexed construction, exact tail handling, and checksums. The
  G#-only CLR-array rows isolate descriptor overhead. A recycled/recycled
  comparison still needs an explicit ownership protocol and its own scenario.

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
