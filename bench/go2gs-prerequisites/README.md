# ADR-0191 prerequisite viability spike

This spike compares hand-written Go and G# implementations of the semantics
that ADRs 0188-0190 added for eventual `go2gs` output. It is deliberately
small: it proves the prerequisite mechanisms, not arbitrary Go compatibility.

## Covered behavior

The paired programs assert identical observable results for:

- shared-storage slicing and append within capacity;
- pointer/managed-location identity across append reallocation;
- a rich object with both a construction-time snapshot and a shared mutable
  lexical capture;
- structural adaptation of a mutable value copy;
- structural adaptation through a retained managed location;
- structural adaptation of a reference source.

The benchmark rows additionally compare:

- slice view creation and amortized append growth;
- managed-location access and creation;
- adapted reference and managed-location calls;
- rich-capture calls and construction;
- generated adapters against hand-written ordinary wrappers;
- rich objects against hand-written named objects over one capture box.

## Run

```sh
python3 build/run-go2gs-prerequisite-spike.py \
  --launches 5 \
  --json out/go2gs-prerequisite-spike/results.json
```

The runner builds the release compiler, emits the G# program once, builds the
Go program, verifies exact semantic output parity, and rotates five JIT,
NativeAOT, and Go process launches. On macOS it adds installed Homebrew
OpenSSL/Brotli paths for the NativeAOT linker. Use `--no-aot` only for quick
iteration.

Numbers are machine observations, not portable budgets. Like the concurrency
harness, the Go ratios are informational.

## September 26, 2026 result

Host: Apple Silicon, 10 logical CPUs, .NET SDK 10.0.400/runtime 10.0.11,
Go 1.27.1. All rows used two million operations and five rotated process
launches.

| Scenario | Go ns/op | G# JIT ns/op | G# AOT ns/op | JIT B/op | AOT B/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| Slice view | 2.11 | 11.97 | 3.32 | 0 | 0 |
| Slice append | 4.03 | 9.11 | 6.64 | 8.39 | 8.39 |
| Managed access | 2.08 | 27.02 | 2.17 | 0 | 0 |
| Managed creation | 0.32 | 29.30 | 27.13 | 80 | 80 |
| Adapted reference call | 2.07 | 27.58 | 0.66 | 0 | 0 |
| Adapted location call | 2.10 | 28.44 | 2.15 | 0 | 0 |
| Adapter construction | 1.19 | 19.53 | 8.71 | 24 | 24 |
| Rich capture call | 2.09 | 7.98 | 3.17 | 0 | 0 |
| Rich-object construction | 1.17 | 68.61 | 56.79 | 248 | 176 |

### Controls

- Generated adapter calls and construction were within 4% of hand-written G#
  forwarding wrappers in both JIT and AOT. Adapter generation adds no measured
  overhead beyond the ordinary wrapper required by ADR-0189.
- The hand-written capture object allocated 24 B/instance. The rich-object
  form allocated 248 B under JIT and 176 B under AOT, and took 3.42x/6.50x as
  long to construct.
- Every steady-state G# row allocated zero bytes per operation.

## Viability conclusion

The prerequisite features are **semantically viable** for the covered Go
constructs. Native slices are also performance-viable in this spike.
Structural adapters meet their own hand-written-wrapper baseline, and AOT
removes the apparent steady-state adapter/location throughput gap.

The prerequisite set is **not yet performance-complete for mechanical Go
translation**:

- #4511 tracks the 80 B cost of creating a managed location.
- #4512 tracks excess rich-object capture/environment construction.
- #4513 tracks translator rules and JIT/AOT performance gates, including
  hoisting address/interface conversions out of hot loops when semantics allow.

These findings do not invalidate ADRs 0188-0190. They constrain how ADR-0191
may claim application-scale readiness.
