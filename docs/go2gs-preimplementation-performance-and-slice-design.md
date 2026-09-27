# Before go2gs: performance, slice syntax, and implementation gates

- **Date:** September 27, 2026.
- **Status:** Design analysis and recommendations; not an accepted language change.
- **Inspected checkout:** `f6cd86cdf735300942aa5578761b0340a6e2f918`,
  also GitHub `main` when checked on September 27.
- **Scope:** The integrated ADR-0191 prerequisite spike, a possible `[]T`
  reinterpretation, current concurrency evidence, and preparation for go2gs.
- **Related:** [ADR-0188](adr/0188-heap-storable-managed-references.md),
  [ADR-0189](adr/0189-capturing-anonymous-objects-and-structural-interface-adaptation.md),
  [ADR-0190](adr/0190-native-slices-and-clr-array-interoperability.md),
  [ADR-0191](adr/0191-go-to-gsharp-migration-tool.md), and
  [ADR-0174](adr/0174-goroutines-and-channels-wave-2.md).

## 1. Executive conclusion

**Proceed toward typed inventory; do not equate the prerequisite milestone
with Go performance parity or readiness to translate an application.**
The integrated work removes two demonstrated sources of excess allocation:
array-location creation is now 40 B rather than 80 B, and shared-root rich
objects allocate the same 24 B as their named controls. Structural adapters
pass their same-runtime call/construction gates. These are substantial,
specific improvements, not evidence that the remaining Go contracts are
implemented. The [spike README][prereq-readme] and [merged policy PR][policy-pr]
state that boundary correctly.

The next decisions should be:

1. **Calibrate before optimizing the large JIT gaps.** The prerequisite
   program enters each benchmark method once, unlike the concurrency
   harness's 120 cheap method entries. Pinning tier settings is not proof that
   every timed method reached optimized code. Several ~27 ns JIT costs also
   occur in ordinary named controls. Inspect generated IL/native code and
   promotion before blaming adapter generation or redesigning the runtime.
2. **Attack fresh capture-root setup next.** It remains 232/200 B per
   operation in JIT/AOT versus 48/48 B for a named box-plus-object control.
   Defer generated field-location keys just as array-location keys are now
   deferred. Then test direct shared-cell capture before considering a new
   managed-reference representation.
3. **Do not change `[]T` as a performance fix.** Making it an alias for the
   existing native slice is an ergonomics and source-compatibility decision.
   It does not optimize `slice[T]`. A one-time breaking transition is
   technically reasonable before 1.0, but only after explicit array syntax,
   shadowing, rank, nullability, cs2gs, and migration gates are settled.
   Until then, retain ADR-0190's additive contract.
4. **Correct benchmark pairing before extending concurrency claims.**
   Current nightlies show promising ping-pong and spawn/join observations,
   but buffered transport and mixed ready/parked select still cost materially
   more than Go. More importantly, the current 1K chunk comparison pairs
   fresh G# arrays with pooled Go buffers and different channel capacities.
   It cannot isolate scalar code generation or transport overhead.
5. **Freeze the Go semantic bridges before broad lowering.** Typed nil,
   original interface identity, copy-per-call value receivers, byte strings,
   fixed-value arrays, panic/defer, and suspension boundaries remain separate
   obligations. Start a small vertical corpus, not a universal IR, global
   adapter cache, custom scheduler, or application-wide runtime rewrite.

All recommendations below are proposed experiments or gates. This report
does not implement them, alter an ADR's acceptance status, or claim new
benchmark measurements.

## 2. Evidence, provenance, and limits

### 2.1 Evidence hierarchy

Use these sources in this order: executable source and raw artifacts;
recorded runs with provenance; committed benchmark summaries; historical ADR
observations. Comments and aspirational targets are not measurements.

| Evidence | Date / identity | What it establishes |
| --- | --- | --- |
| [Integrated prerequisite README][prereq-readme], [G# program][prereq-gs], [Go program][prereq-go], [runner][prereq-runner] | README baseline dated September 27, 2026; Apple Silicon, 10 logical CPUs; SDK 10.0.400, runtime 10.0.11, Go 1.27.1; five launches, two million operations per row | Native-mechanism semantics, control-relative allocation/timing observations, and the implemented measurement policy |
| [Policy PR #4517][policy-pr] / merge `cf8d5acaf` | Merged September 27 at 11:45:06 UTC; final validation attested at clean head `e53298dfb` | The integrated gate passed before merge; final recorded timings are a separate trial, not identical to the rounded README table |
| [Concurrency baseline][concurrency-baseline] and git history | Numeric baseline recorded September 4; policy/provenance amendment September 7; Linux x64, 20 logical CPUs, Intel i7-13800H | Historical named-machine observations; missing comparison key and null toolchain fields prevent using it as a current regression gate |
| [September 27 concurrency run][run-27], artifact `10924871234` | Created 05:30:52 UTC, head `9212ba74bc1b256fa8773e711e3370c3b8fecf57`; four-vCPU AMD EPYC 9V45 hosted runner | Latest completed scheduled run available during this review; three full runs, six launches per mode per run |
| [September 26 run][run-26], artifact `10899307452`; [September 25 run][run-25], artifact `10848466754` | Four-vCPU Intel Xeon Platinum 8370C and AMD EPYC 7763 respectively | Recent observations on different hardware, not a same-machine time series |
| [Concurrency workflow][concurrency-workflow], [registry][concurrency-registry], [G# source][concurrency-gs], [Go source][concurrency-go] | Local source inspected at the checkout above; no changes in these files/runner between September 27's run head and this checkout | What current rows actually execute and which pairings are declared |

The September 27 concurrency artifact's `concurrency.json` SHA-256 is
`f3b778ebf8c7abe7ab7b81cb79943d2350aaa46ecc92f9892d0652a56a18b44e`.
It and the three individual run JSON files were inspected directly from the
GitHub artifact. All three recent nights report SDK **10.0.401**, JIT and
NativeAOT runtime **10.0.12**, and Go **1.27.0**. Do not substitute the
prerequisite host's versions when quoting them.

The September 27 run began before the rich-capture merge at 05:36:23 UTC and
before the policy merge at 11:45:06 UTC. Thus it is not a measurement of the
fully integrated prerequisite head, even though its concurrency benchmark
sources remain current. In Pacific time its start was September 26 at
22:30:52; dates in the nightly tables below are **UTC**.

The original local prerequisite raw JSON was not recovered for this review.
Its numeric table below is explicitly a transcription/calculation from the
committed README, corroborated by the merged PR's separately reported clean
validation. It is not a new run or a reconstruction of confidence intervals.
No benchmark suite was rerun for this documentation-only analysis.

### 2.2 Interpretation rules

- **Go-relative gap:** `G# ns/op / Go ns/op`, within a declared paired row.
  It includes representation, compiler optimization, allocation, GC, and any
  remaining workload-shape differences. It is not automatically a G# defect.
- **Implementation overhead:** G# generated mechanism versus a
  shape-equivalent hand-written control in the **same runtime and launch**.
  This is the right test of avoidable compiler machinery.
- **Workload relevance:** multiply neither ratios from different scenarios
  nor ratios from different machines. A cost matters in proportion to how
  often the eventual program incurs it.
- **JIT and AOT are separate deployment modes.** Both AOT programs contain
  runtime/GC machinery; NativeAOT is not “G# without runtime overhead.”
  Both harnesses feed gsc's emitted IL into the SDK AOT pipeline, rather than
  benchmark a replacement C# implementation. See their
  [prerequisite][prereq-aot] and [concurrency][concurrency-aot] AOT projects
  and the [.NET NativeAOT overview][native-aot].
- **No application-parity percentage is supported.** Neither harness
  translates Go, exercises cliamp's dependency closure, or establishes
  application latency, memory, GC, startup, or platform fidelity.

## 3. Current prerequisite gap classification

### 3.1 Integrated observations

These are the **September 27 README baseline on the 10-logical-CPU Apple
Silicon host**, not the Linux nightlies. Ratios below are calculated from
rounded table medians, not from raw paired launch samples. Smaller is faster.
An operation often includes several reads/writes or a constructor plus a call.

| Row | Go ns/op | JIT ns/op | AOT ns/op | JIT / Go | AOT / Go | G# allocation, JIT / AOT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Slice view | 2.08 | 11.90 | 3.22 | 5.72× | 1.55× | 0 / 0 B |
| Amortized slice append | 3.91 | 9.06 | 6.44 | 2.32× | 1.65× | 8.39 / 8.39 B |
| Managed access | 2.06 | 26.14 | 2.09 | 12.69× | 1.01× | 0 / 0 B |
| Immediate managed creation | 0.32 | 20.93 | 11.82 | 65.41× | 36.94× | 40 / 40 B |
| Retained managed creation | 0.79 | 57.06 | 49.44 | 72.23× | 62.58× | 40 / 40 B |
| First identity observation | 0.42 | 105.46 | 98.21 | 251.10× | 233.83× | 40 / 40 B |
| Warmed identity | 0.54 | 11.96 | 4.67 | 22.15× | 8.65× | 0 / 0 B |
| Direct readonly creation | 0.33 | 36.36 | 26.83 | 110.18× | 81.30× | 40 / 40 B |
| Adapted reference call | 2.10 | 27.16 | 0.62 | 12.93× | 0.30× | 0 / 0 B |
| Adapted location call | 2.07 | 28.24 | 2.13 | 13.64× | 1.03× | 0 / 0 B |
| Adapter construction | 0.68 | 19.56 | 8.53 | 28.76× | 12.54× | 24 / 24 B |
| Rich capture call | 2.17 | 7.91 | 3.11 | 3.65× | 1.43× | 0 / 0 B |
| Shared-root rich construction | 1.19 | 15.67 | 11.53 | 13.17× | 9.69× | 24 / 24 B |
| Retained rich construction | 7.22 | 42.41 | 36.08 | 5.87× | 5.00× | 24 / 24 B |
| Fresh-root rich construction | 0.75 | 82.03 | 72.22 | 109.37× | 96.29× | 232 / 200 B |
| Multi-capture rich construction | 0.74 | 17.49 | 13.20 | 23.64× | 17.84× | 40 / 40 B |

The first-identity row preconstructs handles outside measurement. Its 40 B
is the **additional key**, not the entire lifetime cost: creating an array
handle and then observing identity costs approximately 40 + 40 B on this
profile. Retained-creation destination storage is also allocated outside the
timed loop. Retention introduces write barriers, live heap, and GC behavior;
it is not interchangeable with immediate-use construction. [Benchmark source][prereq-gs]

### 3.2 Which gaps are attributable?

| Classification | Evidence and interpretation | Decision |
| --- | --- | --- |
| Resolved excess allocation | Lazy array keys halve handle construction; retained compiler capture locations make shared-root rich objects match 24 B controls | Preserve these gates; do not propose the same fixes again |
| No demonstrated adapter-specific penalty | README reports paired adapter/control call ratios 1.001/1.001 and construction ratios 0.979/0.996, JIT/AOT; both wrappers allocate 24 B | No adapter-cache project justified by this spike |
| Common JIT cost / codegen hypothesis | Nominal reference calls are 27.28 ns JIT and 0.62 ns AOT, nearly identical to generated adapters; managed access is 26.14 versus 2.09 ns | Inspect promotion, inlining, and dispatch before changing representations |
| Demonstrated remaining setup allocation | Fresh rich roots are 232/200 B versus manual 48/48 B; times are 4.00×/7.21× the manual control | High-priority bounded compiler experiment |
| AOT rich timing question | Shared-root rich construction is 1.35× its named control; multi-capture is 2.10×; retained rich construction is faster at 0.74× | Allocation equality is not timing equality; isolate constructor and call shape |
| Native descriptor overhead | View and append remain 1.55×/1.65× Go under AOT; no raw-array/span/native-C# controls in this spike | Add subcost controls before tightening a native-slice speed budget |
| Structural cost of persistent handles | Go addresses need not allocate a wrapper; G# handles are heap-storable class instances with virtual borrowing and canonical identity | Avoid unnecessary materialization in proven local segments; do not erase required persistence |

There is an additional control qualification: `benchRichCapture` infers the
concrete anonymous type, while `benchManualRichCapture` declares `Counter`.
Several rich-construction rows likewise call through different static types.
These controls match useful heap shapes, but their timings are **not a pure
measure of generated-class overhead**. The 0.29× JIT versus 4.94× AOT
rich-call/control reversal particularly demands matched dispatch variants.
The fresh-root factories both return `Counter`, making that comparison a
stronger setup-path signal. [G# benchmark][prereq-gs]

The sub-nanosecond Go construction/address rows also need restraint. The
source often constructs a nonescaping temporary or repeats the same address;
Go can eliminate or collapse work that an ordinary CLR object representation
retains. This is a legitimate idiomatic result, but dividing by 0.32 ns does
not prove a 65× avoidable handle implementation defect. Keep idiomatic rows
and add separately labeled retained/opaque-call/dynamic-index experiments;
do not disable optimizations in the headline Go program merely to improve
G#'s ratio. [Go benchmark][prereq-go]

### 3.3 Measurement work that precedes a new optimization claim

1. **Entry warmup versus loop warmup.** The prerequisite `Main` calls each
   benchmark once. Its 20,000-iteration inner warmups can warm callees but do
   not give the benchmark method many entries; some rows lack that loop.
   The [concurrency program][concurrency-gs] deliberately makes 120 cheap
   entries and waits for promotion. Compare current versus call-counted
   entry warmup, record tier/code-version evidence for the actual timed
   methods, and retain cold/startup measurements separately.
   [Tiered compilation][tiering] can replace methods during execution;
   the launch environment alone cannot identify which version ran.
2. **Inspect code, not just ratios.** Capture gsc IL and
   [JIT disassembly][jit-disasm] for slice bounds, `Borrow`, wrapper calls,
   and capture constructors. Compare the same runtime APIs called from
   small C# controls to distinguish gsc IL shape from CLR backend behavior.
   Use NativeAOT disassembly for its corresponding bodies.
3. **Add missing control axes.** Separate direct, borrowed, persistent, and
   first/warmed identity access; concrete versus interface dispatch;
   shared/fresh roots; retained versus immediately consumed values; constant
   versus varying owner/index; and one versus many implementations at a call
   site. Do not merge these into one average.
4. **Measure long enough and balance order.** At 0.32 ns, two million
   operations last roughly 0.64 ms. Size new rows by elapsed duration while
   preserving identical counted work across each pair. Five launches satisfy
   the current prerequisite policy but do not complete equal three-mode
   rotation cycles; use six or more balanced launches for new comparisons.
   Counterbalance control/scenario order as well as process-mode order.
5. **Keep allocation denominators honest.** CLR rows use current-thread
   allocated bytes and have no measured object count; Go uses process
   `MemStats` deltas and forces GC before its measured operation. Neither is
   total process memory. Add allocation stacks and GC/retained-heap
   measurements where needed; current-thread bytes are unsuitable for a
   multi-worker workload.
6. **Require durable evidence, not exit zero.** The runner validates semantic
   output and checksums, but returns zero after serializing performance
   status even when a performance check is false. Consumers must explicitly
   require both `evidence.milestone_eligible` and
   `performance_gates.prerequisite_performance_ready` for a performance-ready
   attestation. Semantic completion remains a separate status.
   [Runner][prereq-runner]

## 4. Prioritized performance experiments

“Expected impact” below is a scope or hypothesis, not a promised speedup.
Preserve aliasing, side-effect/check timing, readonly permissions, Go value
copies, and observable CLR wrapper identity throughout.

| Priority | Experiment / likely cause | Expected impact | Risk and semantic constraint | Required discriminating measurement |
| --- | --- | --- | --- | --- |
| P0 | Correct warmup, pairings, escape/dispatch controls | May explain much of the JIT-only gap; no production speedup claimed | Low product risk; changing methodology invalidates old baselines | Current versus entry-warmed IL-identical binaries; tier evidence; six rotated launches and three complete runs |
| P1 | Lazy keys for compiler-generated field/capture handles | Remove cold key/path graphs from fresh roots that never observe identity | Medium compiler risk; retain the selected owner immediately, publish identity safely, preserve cross-helper equality | Fresh-root factory with/without identity; nested/generic fields; allocation stacks and first/warmed identity rows |
| P1 | Avoid unnecessary persistent objects in lowering | Eliminate per-sample 40 B handles and 24 B forwarding wrappers where the source already retains a value or only borrows locally | Medium/high semantic risk; no unconditional hoisting or global cache | Zero-trip/effectful/throwing source witnesses, append-detach and pointer-reassignment cases, retained interface snapshots |
| P1 | Slice fast paths and emitted descriptor traffic | Address ~1.5–1.7× AOT Go gaps, potentially larger JIT gap | Low/medium if confined to validated fast paths; keep bounds order and sharing | Native C# `Slice<T>`, G# method/range syntax, raw owner-offset control, span segment; dynamic bounds and generic/value elements |
| P2 | Direct shared-cell capture where no persistent handle is needed | Approach named box-plus-object allocation; remove virtual `Borrow` from rich calls | Medium/high lowering complexity; closures and explicit addresses must still share one root | Direct-cell versus current handle capture; nested objects/lambdas, early borrows, per-iteration roots, retained identity |
| P2 | Fast array-location equality without key materialization | Reduce ~98–105 ns first observation and possibly its 40 B increment | Medium; same owner/index fast path must coexist with canonical cross-kind/path comparison | Array/array versus array/field versus readonly views; unequal owners, concurrent first observation, stable hash |
| P2 | Match rich call/constructor code shape and devirtualization | Investigate AOT rich/control gaps without regressing good retained rows | Low/medium; never change value-receiver copying or fresh exposed `adapt` semantics | Same static receiver types, one/multiple targets, constructor-only plus consumed/retained rows; emitted IL and AOT code |
| P2 | Buffered-channel/select and chunk cost decomposition | Targets observed ~3–4× channel/select gaps; joins buffer work with prerequisites | Medium; concurrency correctness can dominate modest throughput gains | Corrected fresh/fresh and explicitly pooled/pooled controls, park frequency, contention, allocations, scheduler handoffs |
| Defer | General escape optimizer, new pointer ABI, custom scheduler, hchan rewrite, automatic pooling | Unknown until a representative workload identifies the limiter | High semantic/maintenance risk | No implementation without a benchmark that distinguishes it from smaller fixes |

### 4.1 Fresh-root allocation: the most concrete remaining compiler target

[ManagedReferenceLowerer.CaptureField][managed-lowerer] currently builds a
selected owner, a root `ManagedLocationKey.Object` or parent `GetLocation`,
an extended field key, and a helper containing `Owner` and `Location`.
[ManagedLocationKey.Field][location-key] allocates a new flattened path array
and a new key. [CaptureBoxingRewriter][capture-boxing] now amortizes that
graph across rich objects over one binding; it does not make creating a new
binding cheap. [Field-key emission][field-key-emitter] emits field/type tokens
at construction, explaining why runtime field-handle processing can still
appear in fresh-root profiles.

The smallest next experiment is to make the generated helper's identity path
lazy, leaving `Borrow` and owner retention unchanged. The array implementations
in [ManagedRef][managed-ref] and [ReadOnlyManagedRef][readonly-managed-ref]
provide the publication precedent. Do not silently change the public
`ManagedLocationKey` contract or use a global owner interning table.

A working allocation model for the AOT 200 B row is: 24 B capture box,
32 B helper, 24 B rich object, plus 120 B in two keys and a one-field path.
This is a **model to verify with allocation stacks/layout**, not a new object
count measurement. If correct, lazy field keys could move the no-identity
path toward roughly **80 B** on this host. The remaining difference from the
48 B manual control would justify testing direct-cell capture. Reaching 48 B
is not a precondition for beginning go2gs inventory.

First observation must still construct an equivalent owner/index/constructed
field-path identity. Test readonly/writable equivalence, independent helper
sites, generics, nested value fields, changing referent contents, races, GC
liveness, and retained pointers after append. Deferring internal allocation
must not defer source owner/index evaluation or bounds checks.

### 4.2 Slices: optimize the path, not the contract

[Slice<T>][slice-runtime] stores an owner, offset, length, and capacity.
Its indexing validates logical length then addresses the backing array.
Native range syntax currently calls the four-argument normalization overload
through [BindNativeSliceRange][native-binder], even for ordinary forward
bounds. Append computes a checked length, calls `PrepareAppend`, constructs
a descriptor, and grows/copies only when capacity is exhausted.

Useful independent experiments:

- Compare constant-forward range lowering with the existing normalization
  path, explicit `.Subslice`, and dynamic/from-end bounds. A specialized
  forward path is acceptable only if it retains evaluation order, exceptions,
  capacity rules, and negative-bound rejection.
- Split append into preallocated in-capacity, forced-reallocation, and
  amortized-growth rows. Record capacity trajectory, bytes copied, total
  allocated bytes, and final slack. The current 8.39 B/op is amortized backing
  storage, not a descriptor allocation or an allocation on every append.
- Test a small in-capacity fast path plus a cold growth helper if
  disassembly shows inlining is blocked. Do not choose a growth factor just
  to win one two-million-element endpoint; compare retained memory too.
- Use span/borrowed refs only inside verified nonsuspending segments.
  Do not exchange a heap-storable descriptor for `Span<T>` throughout a
  goroutine pipeline or expose an entire owner to bypass permissions.
- Measure interface-based enumeration separately: the runtime has an
  allocation-free value enumerator, but its `IEnumerable<T>` path is a
  different representation. A range-loop lowering must not accidentally
  add boxing while preserving saved-descriptor/current-element semantics.

### 4.3 Lowering policy beats indiscriminate caching

Carry ADR-0191's existing proof rules into an explicit storage/conversion plan:

- A pointer already represented by a retained location is dereferenced, not
  reconstructed. A source address expression still evaluates owner/index and
  performs checks at the original point.
- A concrete value inserted into an interface is a new snapshot; a pointer
  insertion captures the pointer value, not the future contents of its
  variable. Existing interface copies retain their original tag/payload.
- A value receiver copies per call. Reusing native adapter-owned mutable
  state would be wrong even if it reduces allocation.
- Use a borrowed ref only for a proven nonescaping execution segment, not
  across suspension, unknown callbacks, or retained identity.
- Exposed native G# `adapt` remains a fresh ordinary wrapper. Only private
  Go-lowering implementation objects whose identity cannot escape are
  candidates for reuse.

These are existing [ADR-0191 section 7][adr-go2gs] obligations, not a request
for a speculative whole-program optimizer.

## 5. Breaking change: `[]T` means `slice[T]`

### 5.1 What the implementation does today

The terminology is misleading unless representation is checked:

| Current syntax / operation | Actual current representation / behavior | Evidence |
| --- | --- | --- |
| `[]T`, unshadowed `array[T]` | Exact CLR `T[]`; the historical symbol is named `SliceTypeSymbol` | [Symbol][legacy-slice-symbol], [binder][binder] |
| `[N]T` | CLR-array-backed fixed-length source category, not a Go fixed-array value | [Specification][spec], [ADR-0190][adr-slices] |
| `[n]T` expression | Fresh zero-initialized CLR array; `n` can be a runtime expression | [Specification][spec], [cs2gs allocation lowering][cs-array-lowering] |
| `slice[T]`, `readonly slice[T]` | Nominal constructed value types `Slice<T>` / `ReadOnlySlice<T>` in `Gsharp.Runtime.Values` | [Native binding][binder], [runtime][slice-runtime] |
| CLR array `a[lo..hi]` | Allocate destination and `Array.Copy` | [BindArraySlice][array-range-binder] |
| Native slice `s[lo..hi]` | Save descriptor, evaluate bounds, return shared `Subslice` | [Native slice binder][native-binder] |
| Native buffer literals | Allocate an array; native slice literals explicitly wrap it through `FromArray`; `array[T]{...}` retains array storage | [BindNativeBufferLiteral][native-binder] |
| Ordinary `array`/`slice` names | Visible types/aliases take precedence; escapes force ordinary lookup | [ADR-0190][adr-slices], [binder][binder] |

Do **not** change `SliceTypeSymbol` to mean the native runtime slice. It is
used for legacy arrays, imported-array equivalence, array allocation, and
copying ranges. The new surface should resolve to the same nominal native
type as `slice[T]`; CLR arrays must remain a distinct category internally.

### 5.2 Advantages and costs

**Advantages**

- `[]T` would finally denote a shared, length/capacity-bearing slice rather
  than an array historically called a slice. Go-shaped output and ordinary
  subbuffer code become easier to read.
- Explicit `array[T]` makes CLR ABI and copying-range intent visible.
  `slice[T]` can remain an equivalent long spelling, avoiding gratuitous
  churn in already-correct native-slice source.
- A syntactic `[]T` form could select the native category without depending
  on whether an ordinary identifier named `slice` is in scope.

**Costs**

- This is a semantic and often ABI break, not a rename. An unchanged public
  parameter would change from `T[]` to `Slice<T>`; arrays of arrays become
  slices of slices. Delegates, generic instantiations, reflection, serializers,
  and C# consumers see different types.
- Range and list-pattern-rest behavior would change from copies to shared
  views. Existing code can compile and silently mutate the original buffer.
  Conversely, a retained small view can now keep a large owner alive.
- Reference identity/covariance and CLR array APIs are not slice contracts.
  Native slices are invariant values, have descriptor equality, and use
  explicit sharing/copy APIs. Readonly permission is not immutable storage.
- Default native slices are usable empty descriptors; nullable native slices
  are `Nullable<Slice<T>>`, not nullable array references. Reference
  nullability conversions and byref-slot compatibility cannot be reused
  blindly for the new value-type container.
- Pointer/ref-like element restrictions, bounds/exception paths, overload
  applicability, method sets, and runtime-package availability can change.
  Old arrays with element forms forbidden in native slices must remain arrays
  through migration rather than be rejected without a replacement.
- Tooling must distinguish semantic rewriting from formatting. Existing
  generated source, scripts, samples, SDK templates, and embedded G# strings
  in tests all require attention.

A lexical inventory at this checkout found literal `[]` text in 33 tracked
`.gs` files: 27 under `samples`, five under `src`, and one under `bench`.
This is **not** a semantic site count and excludes the substantial embedded
G# source in C# tests, generated mirrors, documentation, and external users.
It is a lower-bound exposure signal, not evidence that migration is small.

### 5.3 Proposed contract if the switch is approved

Use one storage meaning, independent of context:

| Proposed spelling | Meaning |
| --- | --- |
| `[]T` | Exactly native `slice[T]` |
| `readonly []T` | Exactly `readonly slice[T]`; new parser support required |
| `[]T?` | `slice[T?]`, nullable elements |
| `[]?T` | `slice[T]?`, nullable descriptor |
| `[]?T?` | `slice[T?]?` |
| `[][]T` | `slice[slice[T]]`, not a jagged CLR array |
| `array[T]`, `array[T]?`, `array[T?]` | CLR array, nullable array, array of nullable elements |
| `array[array[T]]` | Jagged CLR array |
| `[N]T` / `[n]T` | Preserve current fixed source category / raw allocation semantics in this change; neither becomes a Go value array |

The prefix nullable convention minimizes grammar churn, but the ADR should
explicitly approve it. An alternative is requiring `( []T )?` for the
container; do not leave precedence implicit. Retain the established
`ref readonly` borrowed-reference precedence and test nested combinations
with readonly slices and handles.

Two decisions are **blocking**, not printer details:

1. **Unshadowable exact-array spelling.** Today a user `array[T]` can shadow
   the native alias, and `[]T` is the fallback. After the switch that fallback
   is gone; `System.Array` cannot stand in for typed `T[]`.
   Recommended solution for an approved breaking epoch: make unescaped
   `array[...]` a dedicated intrinsic type/buffer form, with `$array[...]`
   and qualified ordinary names retaining user-type access. This is an
   additional, explicit amendment to ADR-0190's name-precedence rule.
   Migrate ordinary-name references semantically; do not reinterpret them.
   A dedicated qualified intrinsic is an alternative, but no such escape
   should be assumed to exist today.
2. **Rectangular rank.** `array[T]` currently has arity one and denotes only
   an SZARRAY. C# `T[,]` cannot become `array[T]` without losing rank.
   Preserve `[,]T`/`[,,]T` during a bounded rank-one transition, or approve a
   new explicit intrinsic form such as `array[T, 2]` before requiring all
   cs2gs array types to use `array[...]`. The latter needs grammar/model
   support for a rank constant; it is **not implemented syntax**.
   Prefer an explicit ranked array form for the eventual canonical surface;
   never flatten rank or use nested arrays as a substitute.

Keep sharing conversions explicit: `slice[T].FromArray(a)`, `.ToArray()`,
and whole-owner `.TryGetArray`. Do not auto-copy to satisfy a C# parameter
or infer that `[]T` means an array when an imported overload expects one.
If `[n]T` remains a raw allocation, assigning it to a native slice requires
the explicit wrapper; source migration preserves an array type instead.

This still does **not** make G# slices identical to Go slices. Go nil,
comparison legality, source-width bounds, panic values, and Go-default
elements remain translator responsibilities. In particular, G# descriptor
equality must never implement Go slice equality. [Go specification][go-spec]

### 5.4 Compiler, runtime, and tooling implications

| Layer | Required work for an approved transition |
| --- | --- |
| Parser / syntax tree | Separate unsized native-slice syntax from length/rank array forms in [Parser.TypeClauses][type-parser] and literal parsing; preserve nested types, `?[` splitting, escapes, readonly modifiers, conversions, and source spans |
| Binder / type system | Bind new `[]T` to `NativeSliceTypes` identity, not a renamed legacy symbol; preserve raw arrays and fixed-length rules; audit default values, constraints, nullability, covariance, inference, equality, patterns, and ref-slot rules |
| Lowering / emitter | Reuse existing native range/index/append/managed-location lowering; keep raw `newarr`, copying ranges, and metadata paths untouched for migrated arrays; verify no accidental implicit copies or byrefs in state-machine fields |
| Runtime / packaging | No new descriptor representation is necessary; require the existing compatible Values runtime wherever new `[]T` is used; preserve GS0600 missing-runtime behavior and NativeAOT/reference-assembly support |
| Public ABI | Preserve `T[]` after mechanical migration to `array[T]`; separately version intentional array-to-slice public API changes and rebuild dependent projects |
| Formatter / display / editor | Update [formatter][formatter], [type-clause completion][completion], symbol displays, syntax highlighting, diagnostics, code actions, and debugger-visible names; formatting alone must not change meaning |
| Migration / source generators | Cover cs2gs, generator output, SDK-generated stubs, scripts/REPL, examples, and manifests; target syntax/compiler epoch must be recorded |
| Documentation / tests | Update the current [spec][spec], [compatibility policy][compatibility], ADR amendments, diagnostic/reference pages, coverage matrix, and release notes in the implementation PR; preserve released docs as historical snapshots |

There is already documentation drift worth addressing during that change:
the spec says nullable outer jagged arrays cannot be spelled because of
`?[`, while the parser explicitly splits that token for the nested-array
case. Test the implementation; do not design a migration around that stale
sentence. Likewise, historical `SliceTypeSymbol` comments still describe
retired built-ins and deferred native slices. [Parser][type-parser],
[legacy symbol][legacy-slice-symbol]

### 5.5 cs2gs: array output must remain CLR arrays

The requested invariant is non-negotiable:
**a C# SZARRAY becomes `array[T]`, never the new `[]T`.**

The current translator already distinguishes the semantic categories:

- [CSharpTypeMapper][cs-type-mapper] maps `IArrayTypeSymbol` to
  `ArrayTypeReference`, including rank. Recognized Values runtime types map
  separately to `NativeSliceTypeReference`, or a qualified nominal name when
  shadowed.
- [GSharpPrinter][printer] currently renders `ArrayTypeReference` as `[]T`
  and nullable arrays as `[]?T`. Both its outer `RenderType` path and its
  `RenderTypeCore` array case need attention.
- `ArrayLiteralExpression` is independently printed as `[]T{...}`;
  `ArrayAllocationExpression` prints `[n]T` or multidimensional forms.
  Changing annotations alone would leave inferred C# array literals silently
  becoming slices.
- [Array creation translation][cs-array-lowering] routes explicit and
  implicit initializers through array model nodes and length-only creation
  through array allocation nodes. Audit collection expressions/spreads,
  params packing, casts/defaults, generated helpers, and nested arrays too.
- [NativeSliceTranslationTests][cs-slice-tests] explicitly pin the old
  separation, nullable spellings, shadowed names, and C# copying ranges.
  Those are migration witnesses, not snapshots to bulk-accept blindly.

Keep `ArrayTypeReference` and `NativeSliceTypeReference` separate; do not
replace the former with a named “slice” node. Printer policy changes spelling,
not semantic ownership. C# `Slice<T>` remains a native slice. C# `int[]?`
becomes `array[int32]?`, `string?[]` becomes `array[string?]`, and `int[][]`
becomes `array[array[int32]]`. Explicit array literals become
`array[int32]{1, 2}`. Existing raw `[n]T` allocation may remain while its
expression/result continues to be CLR-array-typed.

The current [round-trip check][roundtrip] only reparses and rejects
error-severity diagnostics. Both an array and a slice program can parse.
Require binding, metadata checks (`T[]` versus `Slice<T>`), ILVerify, and
behavioral parity with C#: range mutation isolation, covariance failures,
nullable containers/elements, `ref`/`out`, `params`, rectangular arrays,
generic signatures, and native interop. This is particularly important for
unannotated/netstandard dependencies that a modern annotated corpus may miss.

### 5.6 Migration and recommendation

**Recommendation: conditional approval for a separately versioned breaking
epoch, not an immediate reinterpretation on `main`.** Keep the current
additive syntax until the following sequence has passed. go2gs M0 need not
wait; production output can use explicit `slice[T]` until the epoch is chosen.

1. **Decide and document.** A new ADR must explicitly supersede the relevant
   ADR-0016/0190 spelling and name-precedence rules. Fix rank, literal,
   readonly, nullable, and array-shadowing decisions. The current
   [pre-1.0 policy][compatibility] permits minor-line breaks but calls for
   migration guidance and a deprecation release when practical.
2. **Prepare explicit arrays under old semantics.** Make cs2gs and other
   generators emit `array[T]` for arrays, with a correct solution for ordinary
   `array` collisions and rank. Deprecate legacy array `[]T` spellings before
   reassignment. Do not break C# array output while merely preparing a future
   slice feature.
3. **Offer a binding-aware rewrite, not search/replace.** Under the old
   compiler's meaning, rewrite array type/literal nodes, nullable nesting,
   inferred literals, and ordinary-name collisions. Preserve comments and
   source maps. A raw regex cannot distinguish types from indexing,
   comments, strings, or a shadowed `array`.
4. **Bank behavior and ABI before switching.** Compile migrated source on
   both sides of the transition; compare public metadata and C# oracles.
   Keep intentional conversions to native slices as separate reviewed edits,
   with `.Clone()`/`.ToArray()` where copy isolation was intended.
5. **Prevent silent old-source reinterpretation.** Require an explicit
   source/compiler epoch acknowledgment in projects and direct script/REPL
   entry points before enabling the new meaning. This version contract is
   proposed work, not an existing CLI switch. A hard-error transition release
   is another safe staging option. Supporting two meanings indefinitely or
   guessing from imports/expected types is not acceptable.
6. **Flip once and regenerate.** Update SDK/tools/editor releases together;
   invalidate old translation manifests/caches; run targeted array/slice
   witnesses, cs2gs corpus/self-migration gates, and then the broader CI
   matrix. Retain `slice[T]` as a stable equivalent spelling.

Alternatives are: keep ADR-0190 indefinitely (lowest cost and fully sufficient
for go2gs); deprecate `[]T` without reusing it (safer, less ergonomic); or
change defaults without an epoch (rejected because valid old source silently
changes aliasing). The syntax switch is a **no-go** if exact-array spelling or
safe migration cannot be guaranteed. That should not block typed Go inventory.

## 6. Combined concurrency and prerequisite assessment

### 6.1 What the current harness says, versus its historical prose

The [README][concurrency-readme] opens with “no budget has been measured” and
“every median is null,” but the committed baseline has numeric JIT/AOT
medians. Its “known limits” also describe a runtime-only rendezvous row,
deterministic ready select, and queue-only spawn that do not describe the
current G# benchmark. The executable [registry][concurrency-registry] has
**12 rows, seven declared Go pairs**, including G# ping-pong and spawn/join.

The current [workflow][concurrency-workflow] runs three complete passes,
aggregates six-launch runs, and uploads raw launch samples. It is
**report-only**, not a performance approval gate. The historical named-host
baseline lacks the comparison fingerprint required by today's runner.
The September 27 and 25 artifacts explicitly say `comparable: false`
because power-state identity is unavailable. September 26 has a comparable
fingerprint but remains a hosted, different-machine observation; it does not
arm the named-workstation baseline.

Current runtime source already implements bounded inline waiter completion
and suppression at unsafe boundaries:
[InlineBudget][inline-budget], [ParkedNode][parked-node], and
[SelectWaiter][select-waiter]. [SelectRandom][select-random] supplies randomized
arm order. Do not propose “turn on synchronous continuations” or “randomize
select” as missing work. Historical [ADR-0174][adr-concurrency] negative
results for hchan rewrites, spin-before-park, and indiscriminate pooling
remain useful cautions, not proof that every future workload is settled.

### 6.2 Recent observed numbers

**September 27, 2026 UTC; four-vCPU AMD EPYC 9V45 hosted Linux x64 runner;
SDK 10.0.401; JIT/AOT 10.0.12; Go 1.27.0.**
Each median comes from the artifact's three-run aggregate, retaining 18
launch samples per mode. Times are ns per declared operation; chunk rows
count **elements**, not channel transfers. [Raw run and artifact][run-27]

| Declared pair | Go | G# JIT | G# AOT | JIT / Go | AOT / Go | Interpretation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Buffered channel, 64 | 32.55 | 93.91 | 107.12 | 2.89× | 3.29× | Material remaining pipeline gap; inspect per-element work and contention |
| Ping-pong round trip | 219.05 | 189.44 | 203.56 | 0.86× | 0.93× | Promising observed two-handoff result, not universal rendezvous superiority |
| Closed receive | 13.60 | 7.83 | 8.24 | 0.58× | 0.61× | Old exception-path defect is not the present limiter |
| Spawn plus join | 111.45 | 76.36 | 78.98 | 0.69× | 0.71× | Empty-body completion shape, not captured/suspending application work |
| Mixed ready/parked select | 54.90 | 195.98 | 187.72 | 3.57× | 3.42× | High-priority channel/select investigation |
| 64-element array chunks | 2.70 | 3.01 | 3.17 | 1.11× | 1.17× | Declared pair, with element-width/construction caveats below |
| 1K-element array chunks | 0.60 | 1.48 | 1.50 | 2.47× | 2.50× | **Not equivalent allocation/transport policy; not a parity estimate** |

The artifact calls its interval field `ci95_ns`, but aggregate provenance says
`intervalMethod: range-of-run-medians`; do not describe it as a conventional
95% confidence interval. For example, the JIT buf64 interval is
93.31–96.09 ns and AOT 106.80–107.20 ns under that aggregation method.

Recent JIT/Go ratios illustrate machine sensitivity, not chronological gains:

| UTC run date / four-vCPU host | buf64 | ping-pong | select-stream | chunk64 | chunk1K, confounded |
| --- | ---: | ---: | ---: | ---: | ---: |
| September 25 / EPYC 7763 | 4.00× | 1.00× | 4.26× | 1.14× | 2.49× |
| September 26 / Xeon 8370C | 3.29× | 0.94× | 3.79× | 1.62× | 5.05× |
| September 27 / EPYC 9V45 | 2.89× | 0.86× | 3.57× | 1.11× | 2.47× |

Sources: [September 25][run-25], [September 26][run-26],
[September 27][run-27]. These are neither three qualifying nights on one
hardware class nor a controlled compiler A/B.

### 6.3 Newly relevant pairing limitations

Inspecting [both][concurrency-gs] [programs][concurrency-go] reveals limits
that the registry's “shape for shape” descriptions do not fully capture:

- **1K allocation/ownership:** Go `chunked1k` recycles buffers through a
  separate pool channel; G# `produceArrays` allocates a fresh array per chunk.
  They also use data-channel capacities 16 and 64 respectively.
  Pool synchronization, ownership, retained lifetime, and allocation differ.
- **1K tail/denominator:** Go sends `N / 1024` whole chunks, or 74,999,808
  elements for `N = 75,000,000`, while G# sends an additional zero-padded
  full array containing the 192-element remainder. Both divide by
  75,000,000. This is a small numerical effect but a concrete pairing defect.
- **Payload widths:** Go uses target-width `int`/`[]int`, 64-bit on these
  hosts; G# uses `int32`/CLR `int32[]`. Element counts are not equal byte
  traffic. Construction uses Go append versus G# indexed filling in the
  64-element case.
- **Observability:** consumer sums/counts are not emitted as cross-runtime
  semantic checksums. Some source work is unused or algebraically trivial.
  The table therefore lacks the prerequisite runner's strong counted-work
  oracle.
- **Timing boundaries:** select's Go producer is launched before the timer,
  whereas G# starts its timer before entering the scope that launches the
  producer. Even small setup differences should be recorded rather than
  attributed to select internals.

Consequently, the historical claim that the 1K inversion proves scalar
array codegen, rather than allocation/transport policy, is too strong for the
current sources. Profile scalar loops **and** GC/ownership, using a corrected
pair. The two possibilities are experimentally separable.

Keep historical rows labeled rather than silently overwriting their meaning.
Create separate fresh/fresh and explicitly recycled/recycled comparisons with
equal widths, capacities, tail handling, counted work, checksums, and timing
boundaries. Only the recycled variant may require a receiver-return ownership
protocol; it must not redefine ordinary retained slice semantics.

### 6.4 What pairing the two efforts unlocks

Native slices supply heap-storable shared subbuffers; value elements avoid
per-frame inner arrays; retained locations/captures support shared state;
goroutine lowering permits channel waits without occupying one thread per
parked operation. Together these support a credible managed streaming
architecture. They do not automatically supply Go's interface, nil,
value-array, panic, or dependency semantics. [ADRs 0174][adr-concurrency],
[0190][adr-slices], [0191][adr-go2gs]

The next combined witness should be a bounded, device-free pipeline:

1. Produce a known `slice[StereoFrame]` and bounded subviews.
2. Transfer descriptors through `chan[slice[StereoFrame]]`, process nested
   value fields, and verify caller-visible mutation and frame-copy
   independence.
3. Retain selected subviews and managed element locations while append
   reallocates another descriptor; confirm old owners remain correct.
4. Include an explicit retained interface value, a fresh value conversion,
   captured mutable state, cancellation, shutdown, and a zero-work path.
5. Measure direct synchronous processing, G# named controls, generated-shape
   G#, and Go with the **same ownership protocol** and meaningful checksums.

Parameterize chunk sizes, producer/consumer count, channel capacity,
ready/park mix, and suspension depths 1/4/16. Measure throughput,
p50/p95/p99 latency, bytes/second, allocation rate, GC pauses, peak/retained
memory, and shutdown leaks. Also measure cold JIT startup separately from
warm JIT and AOT execution.

Do not assume sending a native descriptor is cheaper than sending today's
CLR array reference: its copied payload is larger. Its benefit is correct
subrange/capacity semantics and avoided element copies. Similarly, shallow
parked-memory observations do not establish a deep-stack advantage.

For application prioritization, obtain a same-profile time/allocation
breakdown first. A rough serial model is a weighted sum of component costs;
queueing and GC can invalidate even that approximation. A 2× faster operation
used for 1% of runtime cannot deliver application parity. No meaningful
single “distance to Go” follows from multiplying the prerequisite and
concurrency ratios.

## 7. ADR-0191 feedback and decisions before lowering

The ADR's architecture is appropriate: a pinned typed Go frontend,
Go-specific normalization/storage planning, the existing output model, and
ordered independent validation. Retain its closed-program assembly boundary,
explicit dependency dispositions, offline loading constraints, deterministic
IDs, and fail-closed diagnostics. Do not reuse Roslyn binding as the Go
frontend or introduce a universal optimizer before the first vertical slice.
The following feedback makes that design executable.

| Area | Design feedback / required decision | Gate affected |
| --- | --- | --- |
| Baseline/status | Replace active-text references to “proposed” Values/slice/array capabilities and the old design snapshot with explicit implemented versions; distinguish preserved historical amendments from current requirements | M0 reproducibility |
| Output syntax | Decide target syntax epoch; update the phrase “without changing cs2gs array output” to mean preserved **CLR array semantics**, with explicit `array[T]` spelling if this report's migration is adopted | Before banked M1 generated text |
| Typed interchange | Freeze schema v1 with exact constants/raw string bytes, source/file language versions, target widths, stable IDs, method sets, addressability, selection paths, init order, and bounded failure behavior | Before frontend/driver integration |
| Go interface bridge | Specify dynamic type ID plus copied value/pointer payload, typed nil, interface-to-interface conversion, assertions/type switches, comparability/hash, and `errors.As`; test the bridge separately from native `adapt` | Before admitting interface operations |
| Receiver/capture plan | Describe entry copies, copy-per-call receiver bridges, per-iteration variable identities, promotion once per dynamic root, pointer capture timing, and permitted retained-value reuse | Before pointer/closure lowering |
| Fixed arrays | Keep `[2]float64` and `[10]float64` field-backed value witnesses bounded; specify checked dynamic indexing and addressable nested writes; continue blocking unsupported slicing/escaping element addresses | Before audio fixtures |
| Nil/default/byte strings | Approve representations and helper APIs for nil/empty slices/maps/functions/interfaces, arbitrary byte strings, zero values, UTF-8 iteration, and source-width bounds/panic conversion | Before corresponding semantic corpus rows |
| Control effects | Demonstrate legal G# lowering for eager defer arguments, named results, direct recover, iterator early termination, panic propagation, and `os.Exit` boundaries | Before claiming those Go families |
| Concurrency ABI | Define suspension propagation through direct functions, delegates, interface slots, callbacks and foreign calls; preserve Go launch-argument evaluation and nil-channel/select rules; reject unproven boundaries | Before concurrent package closure |
| Runtime support policy | Version the small Go compatibility library separately from native Values/Channels; generate only demanded closed-world metadata and direct bridges | Before runtime contract release |
| Verification contract | Tie every banked case to semantic status, four-stage verification status, and distinct performance readiness; missing AOT or unsupported neighbors are not green | M1 onward |
| Benchmark policy | Add matched controls/entry warmup and explicit status consumption; preserve integrated raw-total allocation tests and pairwise semantic checks | Performance attestation |
| Workload budgets | Predeclare latency/allocation/GC/memory limits for the exact selected package/profile, rather than manufacture universal Go ratios | M2–M5 |

The richer native ADR-0189 implementation already supports more forwarding
surfaces than ADR-0191 initially admits for Go. That intentional narrowing is
reasonable; record it as a **translator support boundary**, not a missing
native capability. The spike's Go “adapt-copy” witness manually takes a
pointer to a copied struct; it does not prove original Go interface insertion
or repeated value-receiver dispatch. [Spike sources][prereq-go],
[ADR-0189][adr-adaptation]

For the first interface design, decide whether a small tagged value with
specialized bridges can avoid always allocating both a semantic interface
container and a native wrapper. Compare it with a simple correct boxed
representation on typed-nil, copied-value, pointer, and interface-conversion
witnesses. Do not pick an erased `object` representation merely because it
prints easily, and do not optimize before preserving the original tag and
value-copy rules.

For concurrency, native cancellation/scopes are not automatically Go context
or goroutine lifetime semantics. Approve mappings for Mutex/RWMutex, Once,
WaitGroup, atomics, panic propagation, and shutdown. A reentrant,
thread-affine CLR monitor is not a transparent Go mutex. These obligations
are already identified in [ADR-0191][adr-go2gs] and the
[Go memory model][go-memory]; the missing deliverable is a bounded executable
contract matrix, not another prose claim of equivalence.

## 8. Sequenced pre-go2gs roadmap

This is a dependency sequence, not a request to implement every Go feature
before writing the inventory tool. Rows describe **future work**.

| Step / owner | Deliverable | Go / no-go decision |
| --- | --- | --- |
| 0 — Benchmark owners | Freeze source/toolchain profiles; preserve integrated raw evidence; reconcile README/registry drift; correct chunk pairs and warmup controls | Go for measurement infrastructure; no new parity claim until pairs and promotion evidence are valid |
| 1 — Language + cs2gs owners | Choose defer-versus-breaking syntax epoch; settle exact-array escape/rank/nullability; specify array-preserving printer migration | M0 may proceed either way; no syntax flip or stable generated-output promise while decisions are unresolved |
| 2 — Compiler/runtime owners | Run lazy field-key and slice-path A/B experiments; retain #4511/#4512 witnesses; capture allocation stacks and codegen | Land only discriminated improvements; an inconclusive experiment does not justify a rewrite or block inventory |
| 3 — go2gs frontend owner | Implement M0 only: pinned Go/x/tools loader, immutable typed inventory, schema handshake, dependency/platform classification, resource limits | Go when complete/incomplete states and provenance are reliable; no bulk source emission |
| 4 — Lowerer + compatibility owners | One end-to-end M1 vertical slice: exact values/order, byte strings, slice nil/empty, root storage, interface snapshots/typed nil, receiver copies; explicit unsupported diagnostics | Go per admitted family only when original Go, generated JIT/AOT, ILVerify, and mutant witnesses agree |
| 5 — Benchmark + runtime owners | Combined slice/value-frame/channel pipeline, plus depth/retention/cancellation matrix; named-machine baselines | Go for representative concurrency performance claims only after matched workload controls and predeclared budgets |
| 6 — Package owner | Bank `internal/fuzzy`, then `internal/tomlutil`, then `internal/deeplink` with complete selected test variants and closure | M2 no-go on missing API/iterator/error/byte-limit/rejection semantics; source-file counts do not establish coverage |
| 7 — Audio/application owners | Offline EQ/gapless fixtures, then actual headless/IPC/provider closure, then TUI/native/device profiles | M3–M5 advance independently by complete semantic and operational gates; fixture extraction never marks a full dependency migrated |

Before step 3, choose the pinned loader/toolchain and output-schema contract;
before step 4, settle the representations used by the admitted vertical
slice. The full plugin/native/audio dependency problem and all performance
optimizations need not be solved first. Keep CGo, unknown reflection,
unsupported fixed-array shapes, and unsafe address observations visibly
blocked rather than stubbing them.

The cliamp package order and pinned source inventory come from
[ADR-0191][adr-go2gs], not a new type-checked cliamp inventory performed for
this report. Its 557 tracked files and direct-module count must not become
coverage denominators for a selected platform/package graph.

## 9. Risks and open decisions

| Risk / decision | Why it matters | Resolution criterion |
| --- | --- | --- |
| Fresh roots are rare in the target workload | Large microbenchmark allocation savings could have small application impact | Measure dynamic binding frequency and allocation stacks in the first real closures |
| Warmed microbenchmarks overstate deployed behavior | JIT startup, tier changes, megamorphic interfaces, and suspension bodies differ | Publish cold/warm JIT and AOT separately; retain method/code-version evidence |
| Syntax switch silently changes aliasing | Valid old code may compile with shared rather than copied ranges | Explicit epoch plus binding-aware migration and behavioral/ABI comparison |
| `array` collision/rank gap | cs2gs cannot guarantee exact CLR array output with an ambiguous alias or erased rank | Approve an unshadowable intrinsic and rank-preserving policy before the flip |
| Hidden retention | Slice views/handles may keep large arrays or root graphs alive | Measure retained heap after subview creation and post-shutdown collection |
| Premature pooling/cache | Changes ownership, lifetime, snapshot independence, or visible wrapper identity | Explicit ownership/proof contract and a workload showing worthwhile savings |
| Memory model and scheduling boundaries | Native channels alone do not make arbitrary Go concurrency faithful | Independent race-free publication, select, callback, cancellation, and shutdown witnesses |
| Host/toolchain drift | Recent artifacts use three CPU models and newer .NET than the prerequisite baseline | Complete fingerprints; same-host within-runtime gates; report-only elsewhere |
| AOT bridge completeness | Runtime reflection or dynamic code may work under JIT but not NativeAOT | Closed-world generated metadata and mandatory AOT validation per admitted profile |
| Benchmark success-shaped status | Exit zero or workflow success can be mistaken for performance readiness | Require explicit semantic, verification, eligibility, and budget predicates |
| Scope expansion | A syntax redesign or all-Go runtime can delay useful typed inventory indefinitely | Keep M0 independent and bank support by exact family/closure |

## 10. Measurable acceptance criteria

These distinguish existing requirements from proposed new gates.

### Existing prerequisite gate: preserve without weakening

- The exact **11 semantic rows and 23 performance rows** remain present.
  Every measured process must agree with the independent Go semantic oracle;
  paired checksums must agree across runtimes and launches.
- JIT and NativeAOT are both required. A clean committed source state and
  complete provenance are required for milestone-eligible evidence.
- Existing steady-state rows allocate zero; adapter reference-call and
  construction ratios use the **median of same-launch ratios**, at most
  **1.10** in each runtime, with matching adapter/control allocation.
- Immediate, retained, direct-readonly handle creation and the separately
  timed first-identity row remain at most **40 B/op** on the recorded 64-bit
  profile. Warmed identity has no per-operation allocation.
- Shared-root, retained, and multi-capture rich construction match their
  corresponding raw control totals. Preserve the runner's bounded
  **128-byte fixed allowance only at at least one million operations**, not
  rounded per-operation comparisons or an allowance for every operation.
  Fresh-root setup remains separately visible.
- Preserve [runner discrimination tests][prereq-tests]. A performance-ready
  consumer must reject false eligibility/readiness flags, not merely nonzero
  process exits.

### Proposed measurement and optimization gates

- New three-mode comparisons use at least **six balanced launches and three
  complete runs**, with raw rows, matching operation counts, source/artifact
  hashes, exact versions, host/power observations, and matched controls.
  Changed methodology gets a new baseline identity.
- No promotion claim without evidence for the actual timed method/callees;
  no construction claim without an escape/retention description.
- Fresh-field-key work must remove key/path allocation from the
  **no-identity** path, demonstrate a lower raw allocation total than
  232/200 B on a reproduced equivalent profile, and preserve all identity/
  lifetime witnesses. The modeled ~80 B target is exploratory, not an
  approved portable ceiling.
- A candidate timing optimization must have a repeatable same-runtime
  improvement under the predeclared interval method, no semantic regression,
  and no concealed regression in the other execution mode. If the benefit
  overlaps noise, retain the simpler implementation.
- Corrected chunk comparisons must match width, fresh/recycled ownership,
  capacity, tail processing, checksum, and counted operations. Historical
  mismatched rows may report but cannot satisfy a parity gate.

### Proposed syntax / cs2gs release gate

- Every migrated C# rank-one array type/literal prints as explicit
  `array[T]`, including nested/nullable/generated forms; none becomes native
  `[]T`. Rectangular arrays preserve rank under the approved notation.
- Public C# array signatures still encode CLR array metadata before/after
  migration; explicit native slices still encode the Values runtime types.
- Array range/list-pattern copies, native shared views, covariance,
  readonly/native element permissions, nullability, overloads, `params`,
  `ref`/`out`, source-order checks, and missing-runtime diagnostics have
  positive and negative witnesses.
- Formatter idempotence, parser round-trip, binding, implementation/reference
  assembly consumption, ILVerify, C# behavioral parity, and relevant
  cs2gs/self-migration gates pass. A mutant that prints an array as the new
  slice syntax must fail **semantic or metadata** validation, not just a
  text snapshot.
- Old-epoch source is never silently accepted with new semantics; ordinary
  `array`/`slice` collisions and scripts/REPL have documented migration paths.

### Proposed go2gs progression gate

- **M0:** complete typed selected graph or explicitly incomplete inventory;
  pinned source/toolchain/profile; all dependency dispositions and blockers
  retained. Performance recording is required, speed parity is not.
- **M1:** every admitted family has deterministic emitted source/maps, all
  four validation stages, independent Go/JIT/AOT observations, at least one
  discriminating wrong-lowering witness, and diagnosed unsupported neighbors.
- **M2–M3:** complete selected package/fixture scope, approved same-runtime
  latency/allocation budgets, no hidden buffer copies or avoidable per-sample
  conversions/locations, and no per-frame boxing or inner arrays.
- **M4–M5:** approved same-profile throughput, tail-latency, allocation-rate,
  GC, memory, resource/shutdown, and platform-oracle limits. Missing native
  dependencies or application behavior remain no-go conditions regardless
  of microbenchmark results.

**Bottom line:** the native prerequisites are useful and viable; the largest
remaining demonstrated allocation target is fresh-root setup. Establish
honest optimized-JIT and concurrency controls, preserve CLR arrays through
any syntax change, and build the smallest typed semantic pipeline that can
fail loudly. That is a smoother path to go2gs than pursuing an unsupported
headline of Go parity first.

## Source index

Repository links refer to the inspected checkout; GitHub run links identify
dated observations, not perpetual “latest” results. External specifications
are primary sources checked for this review; implementation must still pin
the source language/toolchain versions required by ADR-0191.

[adr-go2gs]: adr/0191-go-to-gsharp-migration-tool.md
[adr-slices]: adr/0190-native-slices-and-clr-array-interoperability.md
[adr-adaptation]: adr/0189-capturing-anonymous-objects-and-structural-interface-adaptation.md
[adr-concurrency]: adr/0174-goroutines-and-channels-wave-2.md
[compatibility]: compatibility-and-stability.md
[spec]: ../website/docs/ref/spec.md
[prereq-readme]: ../bench/go2gs-prerequisites/README.md
[prereq-gs]: ../bench/go2gs-prerequisites/gsharp/Program.gs
[prereq-go]: ../bench/go2gs-prerequisites/go/main.go
[prereq-runner]: ../build/run-go2gs-prerequisite-spike.py
[prereq-tests]: ../build/test-go2gs-prerequisite-spike.py
[prereq-aot]: ../bench/go2gs-prerequisites/aot/SpikeAot.csproj
[concurrency-readme]: ../bench/concurrency/README.md
[concurrency-baseline]: ../bench/concurrency/baseline.json
[concurrency-registry]: ../bench/concurrency/scenarios.json
[concurrency-workflow]: ../.github/workflows/concurrency-bench.yml
[concurrency-gs]: ../bench/concurrency/gsharp/Bench.gs
[concurrency-go]: ../bench/concurrency/go/main.go
[concurrency-aot]: ../bench/concurrency/aot/BenchAot.csproj
[slice-runtime]: ../src/Sdk/Gsharp.Runtime.Values/Slice.cs
[managed-ref]: ../src/Sdk/Gsharp.Runtime.Values/ManagedRef.cs
[readonly-managed-ref]: ../src/Sdk/Gsharp.Runtime.Values/ReadOnlyManagedRef.cs
[location-key]: ../src/Sdk/Gsharp.Runtime.Values/ManagedLocationKey.cs
[managed-lowerer]: ../src/Core/CodeAnalysis/Lowering/ManagedReferenceLowerer.cs
[capture-boxing]: ../src/Core/CodeAnalysis/Lowering/CaptureBoxingRewriter.cs
[field-key-emitter]: ../src/Core/CodeAnalysis/Emit/MethodBodyEmitter.ManagedReferences.cs
[legacy-slice-symbol]: ../src/Core/CodeAnalysis/Symbols/SliceTypeSymbol.cs
[binder]: ../src/Core/CodeAnalysis/Binding/Binder.cs
[array-range-binder]: ../src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.MemberLookup.cs
[native-binder]: ../src/Core/CodeAnalysis/Binding/ExpressionBinder.NativeSlices.cs
[type-parser]: ../src/Core/CodeAnalysis/Syntax/Parser.TypeClauses.cs
[printer]: ../tools/cs2gs/Cs2Gs.CodeModel/Printing/GSharpPrinter.cs
[cs-type-mapper]: ../tools/cs2gs/Cs2Gs.Translator/CSharpTypeMapper.cs
[cs-array-lowering]: ../tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.Patterns.cs
[cs-slice-tests]: ../tools/cs2gs/Cs2Gs.Tests/NativeSliceTranslationTests.cs
[roundtrip]: ../tools/cs2gs/Cs2Gs.CodeModel/RoundTrip/GSharpRoundTrip.cs
[formatter]: ../src/Formatting/GSharp.Formatting/GSharpFormatter.cs
[completion]: ../src/LanguageServer/TypeClauseCompletions.cs
[inline-budget]: ../src/Sdk/Gsharp.Runtime.Channels/InlineBudget.cs
[parked-node]: ../src/Sdk/Gsharp.Runtime.Channels/ParkedNode{T}.cs
[select-waiter]: ../src/Sdk/Gsharp.Runtime.Channels/SelectWaiter.cs
[select-random]: ../src/Sdk/Gsharp.Runtime.Channels/SelectRandom.cs
[policy-pr]: https://github.com/DavidObando/gsharp/pull/4517
[run-27]: https://github.com/DavidObando/gsharp/actions/runs/36297424277
[run-26]: https://github.com/DavidObando/gsharp/actions/runs/36220987236
[run-25]: https://github.com/DavidObando/gsharp/actions/runs/36098945417
[go-spec]: https://go.dev/ref/spec
[go-memory]: https://go.dev/ref/mem
[native-aot]: https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/
[tiering]: https://github.com/dotnet/runtime/blob/main/docs/design/features/tiered-compilation.md
[jit-disasm]: https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/jit/viewing-jit-dumps.md
