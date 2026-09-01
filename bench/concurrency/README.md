# `bench/concurrency` — paired CLR / Go concurrency baseline

Evidence harness for **ADR-0174** (goroutines and channels, wave 2). It exists
to make the ADR's performance claims refutable, and to stop new ones from
being asserted without measurement.

> **Status: baseline only.** This is the Phase-0 spike promoted verbatim from
> the ADR-0174 design work. It measures *today's* lowering and the CLR
> primitives the ADR proposes to adopt. It does **not** yet measure G# — there
> is no G# side until the phases land, and it is **not** wired into CI. D11
> Phase 5 turns this into the gated suite.

## Layout

| Path | What it is |
| --- | --- |
| `clr/` | C# baseline. Reproduces the exact call sequences the G# emitter produces today (`gs-*` rows), plus the CLR primitives ADR-0174 proposes (`best-*` rows). |
| `go/` | Go baseline for the same scenarios. |

## Running

```sh
# CLR side — Release is mandatory, Debug numbers are meaningless
cd clr && dotnet run -c Release

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

- **There is no rendezvous row.** Wave 1 has no rendezvous channel, so the
  ping-pong row uses a capacity-1 bounded channel — *strictly easier* than
  Go's unbuffered rendezvous, which cannot complete a send before a receiver
  arrives. The real rendezvous baseline must be built in Phase 1.
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
