# Ten concurrency patterns: G# and Go

Original, runnable comparison examples for the G# website. The pattern inventory follows the author's Go/G# exploration, but the old capability ratings are not copied as current facts.

## Run

G# requires the .NET 10 SDK and restores `Gsharp.NET.Sdk/0.4.591`:

```sh
dotnet run --project gsharp -- worker-pool
```

For Go, use Go 1.27:

```sh
cd go
go run . worker-pool
```

The other IDs are `bounded`, `pipeline`, `fan-in`, `ttl-cache`, `rate-limit`, `all`, `timeout`, `ownership`, and `atomic-lazy`.

Each example performs its stated checks and prints a deterministic summary. A failed invariant causes a nonzero process exit. Pattern source files share only the command dispatcher and assertion helper in `Program.gs` / `main.go`.

## Verify both implementations

From the G# repository root:

```sh
python3 website/tests/verify-concurrency-patterns.py
python3 website/tests/verify-concurrency-patterns.py --race
```

The verifier builds the actual downloadable bundle, runs all ten pairs repeatedly, compares their exact summaries, and checks rejection of an invalid receive-only send in both compilers. `--race` also builds and runs the Go race detector; it requires a supported Go/C toolchain. This is not an equivalent dynamic race detector for G#.

Admission-before-spawn has a separate structural check that rejects acquire-inside-worker mutations; the runtime peak counter alone does not prove that ordering. The verifier also substitutes unrelated G# errors into the clock/overflow guards and requires the precise negative checks to reject them.

## Read the contracts, not just the syntax

`patterns.json` records the shared checks, language-specific choices, limitations, and related benchmark operations. These are teaching programs with explicit workloads, not production-ready caches, rate limiters, or a general task framework.

In particular:

- cancellation is cooperative and does not stop arbitrary external effects;
- cancellation normalization uses error category and context state, not a proof of which operation caused cancellation;
- Go error returns and panics are not interchangeable with CLR exceptions;
- clocks use controlled ticks, not sleep-based expiry assertions;
- the caches/limiters do not implement eviction or distributed fairness;
- ordering across producers is deliberately unspecified.

The G# cache must not suspend while holding its thread-affine reader/writer lock. The limiter awaits asynchronous admission. Timer handles use `using let` to stop losing deadlines promptly, and the examples check the SDK's `merge` and `Context.WithTimeout` helpers without claiming their semantics are identical to the hand-written topology.

The website's benchmark table consumes `concurrency-bench.yml` artifacts. Those are lower-level benchmark programs at their recorded commit, **not timings of these teaching programs or the published SDK**. No performance claim should be inferred from the correctness checks.
