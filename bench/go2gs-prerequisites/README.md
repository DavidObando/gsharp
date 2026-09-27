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
- managed-location access, immediate creation, retained creation, first and
  warmed identity observation, and direct readonly creation;
- adapted reference and managed-location calls;
- rich-capture calls and construction;
- generated adapters against hand-written ordinary wrappers;
- rich objects against hand-written named objects over one capture box;
- shared-root construction with deliberately retained objects;
- fresh-root construction that includes capture-box/location setup; and
- two-capture/two-snapshot construction against a shape-matched named object.

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

## September 26, 2026 baseline

Host: Apple Silicon, 10 logical CPUs, .NET SDK 10.0.400/runtime 10.0.11,
Go 1.27.1. All rows used two million operations and five rotated process
launches.

| Scenario | Go ns/op | G# JIT ns/op | G# AOT ns/op | JIT B/op | AOT B/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| Slice view | 2.11 | 11.97 | 3.32 | 0 | 0 |
| Slice append | 4.03 | 9.11 | 6.64 | 8.39 | 8.39 |
| Managed access | 2.08 | 27.02 | 2.17 | 0 | 0 |
| Managed immediate creation | 0.32 | 20.91 | 12.18 | 40 | 40 |
| Managed retained creation | 0.79 | 56.37 | 49.86 | 40 | 40 |
| Managed first identity | 0.42 | 105.79 | 98.85 | 40 | 40 |
| Managed warmed identity | 0.54 | 11.94 | 4.68 | 0 | 0 |
| Managed direct readonly creation | 0.33 | 36.12 | 26.93 | 40 | 40 |
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
- Before #4511, immediate managed creation measured 29.30 ns/op and 80 B/op
  under JIT, and 27.13 ns/op and 80 B/op under NativeAOT. Lazy key creation
  halves construction allocation to 40 B/op. Retained handles use the same
  budget; their destination array is allocated before measurement and consumed
  afterward. First identity observation pays the deferred 40 B key cost, while
  warmed identity allocates zero.

## Viability conclusion

The prerequisite features are **semantically viable** for the covered Go
constructs. Native slices are also performance-viable in this spike.
Structural adapters meet their own hand-written-wrapper baseline, and AOT
removes the apparent steady-state adapter/location throughput gap.

The prerequisite set is **not yet performance-complete for mechanical Go
translation**:

- #4511 reduces managed-location creation from 80 B to the ordinary 40 B
  handle allocation; further reduction would require a broader representation
  or escape-analysis change.
- #4512 tracks excess rich-object capture/environment construction.
- #4513 tracks translator rules and JIT/AOT performance gates, including
  hoisting address/interface conversions out of hot loops when semantics allow.

These findings do not invalidate ADRs 0188-0190. They constrain how ADR-0191
may claim application-scale readiness.

## September 26, 2026 rich-capture correction

Issue #4512 retains the compiler-generated managed location once per dynamic
mutable binding instead of rebuilding it for every rich object. Five rotated
launches on the same host measured:

| Scenario | G# JIT ns/op | G# AOT ns/op | JIT B/op | AOT B/op | Named control JIT/AOT B/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shared-root rich construction | 15.65 | 11.49 | 24 | 24 | 24 / 24 |
| Shared-root, retained objects | 45.54 | 41.10 | 24 | 24 | 24 / 24 |
| Fresh capture root per object | 88.98 | 78.95 | 232.08 | 200 | 48 / 48 |
| Two captures plus two snapshots | 17.46 | 13.27 | 40 | 40 | 40 / 40 |

The original `rich-create` emitted, inside each measured iteration, a fresh
rich object plus a generated managed-location helper, a root
`ManagedLocationKey`, an extended field key, and a one-element field-path
array. Its IL called `ManagedLocationKey.Object` and `.Field` immediately
before each rich constructor call. This accounted for 176 B/op under
NativeAOT. The JIT-only additional 72 B/op was traced under
`ManagedLocationKey.Field` through `RuntimeFieldInfoStub.FromPtr`; it is a
CoreCLR runtime-field materialization cost, not an unobserved closure
environment.

After the correction, the helper/key/path graph is constructed once beside
the capture box. The measured loop loads that retained handle and executes
only the rich-object `newobj`, matching the 24 B named control in both JIT and
NativeAOT. The fresh-root row intentionally still exposes the complete
per-binding setup graph; it is not subject to the shared-root 24 B budget.
