# ADR-0191 prerequisite viability spike

This spike compares hand-written Go and G# implementations of the semantics
that ADRs 0188-0190 added for eventual `go2gs` output. It is deliberately
small: it proves the prerequisite mechanisms, not arbitrary Go compatibility.

## Covered behavior

The paired programs assert identical observable results for:

- shared-storage slicing and append within capacity;
- pointer/managed-location identity across append reallocation;
- owner/index selection before reslicing and one-time index evaluation;
- distinct factory-created locations;
- a rich object with both a construction-time snapshot and a shared mutable
  lexical capture;
- structural adaptation of a mutable value copy;
- independent concrete-value conversions retaining independent snapshots;
- structural adaptation through a retained managed location;
- pointer/location capture surviving reassignment of the pointer variable;
- structural adaptation of a reference source.
- zero-trip control flow not evaluating an adaptation source.

These are hand-written native-mechanism witnesses, not generated-code or
translator tests. Current G# primitives do not faithfully represent a Go
interface's original dynamic type/value pair, typed nil, interface-to-interface
conversion, Go comparison/hash/type-switch/map-key rules, or copy-per-call
value receivers. The spike records those as unsupported translator/runtime
bridge boundaries rather than fabricating parity with CLR nullability or
adapter wrapper identity.

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
Go program, requires the exact non-empty semantic row set independently from
Go, pinned-tier JIT and NativeAOT, and rotates five process launches. It also
requires paired checksum parity across runtimes.

The JSON retains every raw launch row: elapsed timer ticks/frequency, operation
count, allocated-byte total, available allocation count, and checksum. Go
reports its exact malloc-count delta; the current CLR measurement API reports
exact thread-allocated bytes but not an object count, represented as `-1` in
raw rows and `null` in summaries. Provenance includes repository/source/artifact
hashes, exact SDK/runtime/toolchain output, reported runtime versions, target
RID, host details, commands, launch order and pinned tier settings.

On macOS the runner adds installed Homebrew OpenSSL/Brotli paths for the
NativeAOT linker. `--no-aot` is explicitly exploratory, emits
`milestone_eligible: false`, and cannot satisfy any ADR-0191 milestone gate.
A full run also remains exploratory while tracked or non-output untracked
source changes exist; rerun it on the committed head for milestone evidence.

The JIT launch environment removes ambient tier/JIT overrides and pins tiered
compilation, dynamic PGO, and a zero call-counting delay. This is the
repository's pinned tiered-PGO steady-state configuration; it does not claim
that the runtime exposes proof of an internal tier for every measured method.
Warmups, same-runtime controls, raw samples and the exact environment remain
part of the evidence.

Numbers are machine observations, not portable budgets. Like the concurrency
harness, the Go ratios are informational.

Runner gate self-checks:

```sh
python3 build/test-go2gs-prerequisite-spike.py
```

The ADR-0154 mutants remove all semantic rows, drift only NativeAOT semantics,
and corrupt one paired checksum. Each must fail its intended gate.

## September 26, 2026 result

Host: Apple Silicon, 10 logical CPUs, .NET SDK 10.0.400/runtime 10.0.11,
Go 1.27.1. All rows used two million operations and five rotated process
launches.

| Scenario | Go ns/op | G# JIT ns/op | G# AOT ns/op | JIT B/op | AOT B/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| Slice view | 2.08 | 11.95 | 3.26 | 0 | 0 |
| Slice append | 3.98 | 9.08 | 6.48 | 8.39 | 8.39 |
| Managed access | 2.07 | 26.32 | 2.13 | 0 | 0 |
| Managed creation | 0.32 | 29.24 | 26.77 | 80 | 80 |
| Adapted reference call | 2.07 | 27.33 | 0.62 | 0 | 0 |
| Adapted location call | 2.07 | 28.12 | 2.12 | 0 | 0 |
| Adapter construction | 1.18 | 19.34 | 8.54 | 24 | 24 |
| Rich capture call | 2.04 | 7.87 | 3.14 | 0 | 0 |
| Rich-object construction | 1.15 | 67.47 | 58.19 | 248 | 176 |

### Controls

- Generated adapter calls and construction were within 3.1% of hand-written G#
  forwarding wrappers in both JIT and AOT. Adapter generation adds no measured
  overhead beyond the ordinary wrapper required by ADR-0189.
- The hand-written capture object allocated 24 B/instance. The rich-object
  form allocated 248 B under JIT and 176 B under AOT, and took 3.45x/6.73x as
  long to construct.
- Every steady-state G# row allocated exactly zero bytes across two million
  measured operations after moving timer setup outside the allocation window.

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

## Acceptance policy

Semantic completion and performance readiness are reported separately:

- M0 records reproducible profiles and unsupported cases; measurements do not
  block inventory.
- M1 requires independent Go/JIT/AOT semantic and discrimination witnesses.
  Performance readiness additionally requires zero-allocation steady-state
  paths, adapter construction matching a shape-equivalent named wrapper, and
  approved allocation gates from open issues #4511 and #4512.
- M2 requires package-specific same-runtime controls and approved budgets.
- M3 adds workload latency/allocation limits and forbids avoidable per-sample
  conversions, locations, boxing, inner arrays and hidden slice copies.
- M4-M5 require representative throughput, tail-latency, allocation-rate, GC
  and memory budgets for each application/platform profile.

Pinned-tier JIT and NativeAOT are both mandatory. The initial investigation
threshold for adapter call/construction time is at most 1.10x its same-run,
same-runtime named control, with allocation matching the control. It requires
at least five rotated launches and retained raw samples; maintainers must
approve profile budgets before a performance-ready claim. Go ratios remain
informational.
