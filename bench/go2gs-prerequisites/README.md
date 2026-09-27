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
corrupt one paired checksum, duplicate or malform a performance row, and fail
each timing/allocation policy check. Each must fail its intended gate.

## September 27, 2026 integrated baseline

Host: Apple Silicon, 10 logical CPUs, .NET SDK 10.0.400/runtime 10.0.11,
Go 1.27.1. All rows used two million operations and five rotated process
launches.

| Scenario | Go ns/op | G# JIT ns/op | G# AOT ns/op | JIT B/op | AOT B/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| Slice view | 2.08 | 11.90 | 3.22 | 0 | 0 |
| Slice append | 3.91 | 9.06 | 6.44 | 8.39 | 8.39 |
| Managed access | 2.06 | 26.14 | 2.09 | 0 | 0 |
| Managed immediate creation | 0.32 | 20.93 | 11.82 | 40 | 40 |
| Managed retained creation | 0.79 | 57.06 | 49.44 | 40 | 40 |
| Managed first identity | 0.42 | 105.46 | 98.21 | 40 | 40 |
| Managed warmed identity | 0.54 | 11.96 | 4.67 | 0 | 0 |
| Managed direct readonly creation | 0.33 | 36.36 | 26.83 | 40 | 40 |
| Adapted reference call | 2.10 | 27.16 | 0.62 | 0 | 0 |
| Nominal reference call | 2.17 | 27.28 | 0.62 | 0 | 0 |
| Adapted location call | 2.07 | 28.24 | 2.13 | 0 | 0 |
| Adapter construction | 0.68 | 19.56 | 8.53 | 24 | 24 |
| Nominal construction | 0.31 | 19.70 | 8.58 | 24 | 24 |
| Rich capture call | 2.17 | 7.91 | 3.11 | 0 | 0 |
| Manual rich capture call | 2.17 | 27.25 | 0.63 | 0 | 0 |
| Shared-root rich construction | 1.19 | 15.67 | 11.53 | 24 | 24 |
| Manual shared-root construction | 1.18 | 19.43 | 8.52 | 24 | 24 |
| Retained rich construction | 7.22 | 42.41 | 36.08 | 24 | 24 |
| Manual retained construction | 6.97 | 51.80 | 48.84 | 24 | 24 |
| Fresh-root rich construction | 0.75 | 82.03 | 72.22 | 232 | 200 |
| Manual fresh-root construction | 0.33 | 20.52 | 10.02 | 48 | 48 |
| Multi-capture rich construction | 0.74 | 17.49 | 13.20 | 40 | 40 |
| Manual multi-capture construction | 1.20 | 20.11 | 6.29 | 40 | 40 |

### Controls

- Median same-launch adapter/control ratios were 1.001/1.001 for reference
  calls and 0.979/0.996 for construction in JIT/AOT. Adapter generation stays
  within the 1.10 timing gate and matches the 24 B construction control.
- Shared-root, retained and multi-capture rich construction matched their
  shape-equivalent controls at 24, 24 and 40 B/op respectively in both JIT
  and AOT. Fresh-root construction intentionally records the full setup graph.
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

The prerequisite mechanisms now pass the spike's JIT and NativeAOT control
gates. #4511 reduced managed-location creation to one 40 B handle and deferred
the identity key; #4512 made shared-root rich construction match its
shape-equivalent named controls. Fresh-root construction intentionally includes
the once-per-dynamic-binding capture setup graph and remains visible in the
evidence rather than being compared with a shared-root control.

These findings do not invalidate ADRs 0188-0190. They constrain how ADR-0191
may claim application-scale readiness: passing this synthetic prerequisite
gate does not establish package or application workload budgets.

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

## Acceptance policy

Semantic completion and performance readiness are reported separately:

- M0 records reproducible profiles and unsupported cases; measurements do not
  block inventory.
- M1 requires independent Go/JIT/AOT semantic and discrimination witnesses.
  Prerequisite performance readiness additionally requires zero-allocation
  steady-state paths, adapter construction matching its named wrapper, the
  #4511 40 B managed-handle ceilings, zero warmed-identity allocation, and
  #4512 shared-root rich construction matching shape-equivalent controls.
- M2 requires package-specific same-runtime controls and approved budgets.
- M3 adds workload latency/allocation limits and forbids avoidable per-sample
  conversions, locations, boxing, inner arrays and hidden slice copies.
- M4-M5 require representative throughput, tail-latency, allocation-rate, GC
  and memory budgets for each application/platform profile.

Pinned-tier JIT and NativeAOT are both mandatory. The adapter call/construction
threshold is the median of same-launch measured/control ratios and must be at
most 1.10 in each runtime, with adapter allocation matching the control on
every launch. It requires at least five rotated launches and retained raw
samples. Go ratios remain informational.
