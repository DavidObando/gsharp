# Compiler architecture and performance study

- **Date**: 2026-10-22
- **Scope**: `src/Core`, `src/Compiler`, `src/Sdk`, `tools/gsgen`, and the
  language server where it reaches into `src/Core`.
- **Related**: #2189 (compiler parallelism tracker), ADR-0203 (measured
  throughput program), ADR-0027 (Roslyn-free emitter), ADR-0105 and ADR-0107
  (language-server incrementality), ADR-0186 and ADR-0193 (nullability).
- **Source studied**: `main` at `a1190b9b7`, built with the pinned published
  SDK 0.5.212.

This document is a study, not a decision. It records how the compiler is
structured today, where the time goes, which improvements #2189 has already
landed, and which changes are left. Every recommendation names its evidence,
its expected gain, its risk, and whether it touches the N-1 rule or a bootstrap
hazard (`CLAUDE.md`). Numbers are **measured** unless a row says **estimated**.

## 1. Summary

The compiler is a single-tree design: one `SyntaxNode` layer with
no red/green split, one eager `Binder` that constructs a full object graph per
method body, a scope chain that is walked for every name, reflection
(`MetadataLoadContext`) as the metadata model, and an emitter that writes
ECMA-335 tables through `System.Reflection.Metadata`. It is correct and
deterministic, and the #2189 work has removed the worst algorithmic defects
(alias and import scans, metadata definition scans, iterator allocation).

Measured on this host, compiling `src/Core` (707 files, 333k lines, 173
references) takes **27.1 s wall, 30.6 s CPU, 1.03 GiB peak RSS** with the
published 0.5.212 compiler, one worker. The compile is single-threaded in
practice (CPU is 1.13x wall). A hello-world compile takes **0.56 s** against
**0.31 s** for `csc`, and 0.2 s of that is indexing the reference closure.
Body binding is 57% of the Core compile; declaration binding, parsing and the
internal analyzers are most of the rest. Emit and lowering together are under 10%.

The headline conclusions:

1. **Binding does repeated work per body, not per compilation.** A new
   `Binder` object graph (about 700 lines of closure wiring plus about 20
   collections) is built for every body; the imported-extension scan over
   `Assembly.GetTypes()` of every reference is cached on that per-body object;
   the narrowing pass walks each statement's subtree two or three times per
   enclosing block. These are the largest remaining sequential costs and they
   are fixable without threads (section 7, P1 to P4).
2. **The metadata model is reflection, and reflection is paid eagerly.** Every
   reference image is read into memory, every type in the closure is
   materialized to build the name index, every member array is enumerated and
   its signature types resolved on first touch, and `[Nullable]` symbols are
   rebuilt on every read. Roslyn's `PEModuleSymbol` design (lazy, per-handle,
   no `System.Type`) is the model to move toward, in stages (section 7, P5 to
   P7; section 8).
3. **A method body is walked 35 to 45 times between parse and IL** (estimated
   from call sites). Lowering passes are not fused; the same questions (does
   this body yield, is this expression pure, what does this lambda capture)
   are answered by several independent walkers; lambda bodies are lowered and
   discarded up to five times before the real lowering. Fusing and caching
   these is both a simplification and a speedup (section 6, S4 to S6).
4. **About a quarter of the Core compile is the JIT running the compiler's
   own code un-optimized or instrumented.** `DOTNET_TieredPGO=0` alone takes
   Core from 26.1 s to 18.8 s (-27.8%, five interleaved pairs, both the
   fresh and the published compiler) and LanguageServer from 3.40 s to 2.76 s,
   with byte-identical output (section 4.5). `PublishReadyToRun=false` is
   explicit in the SDK packaging, the compiler worker is off by default and
   retires on any analyzer, and `gsc` never adopts the metadata index that
   the language server already persists (section 7, P8 to P10).
5. **The compiler's own code generation costs the compiler.** `for ... in`
   over a generic collection whose element type is a compiler-defined type
   boxes the enumerator through `IEnumerable<T>`, because the symbolic
   lowering path trades the struct enumerator for a representable element
   type (decompiled from the built `GSharp.Core.dll`); boxing is 12.4% of
   main-thread samples and most of the compiler's 2,991 `for ... in` loops
   have that shape. Set copies in definite assignment and narrowing are
   another 5.8% (section 4.7; P13, P3, S5).
6. **The nullability wrapper design is sound but its consumer migration has
   not happened.** ADR-0193 Phase 3 has not landed; open-coded
   `is NullableTypeSymbol` / `is PlatformTypeSymbol` tests grew from 503 to
   685 sites since the ADR's audit (section 6, S2).

The five work items I would start first, in this order, are P8 (1)
(`TieredPGO=false` for the published compiler, a one-line change with a
measured -28%), P2 (imported-extension index owned by the compilation), P3
(one effect summary per statement for narrowing), P13 (struct enumerators in
`for ... in` lowering), and P5 (cache decoded imported signatures). P1 (the
`Binder` services split) is the structural item that unblocks the parallel
body phase and should start in parallel as its own lane. Each is one PR for
one agent. The roadmap (section 9) gives acceptance criteria and the
serialization constraints.

## 2. Method

### Host and inputs

- Linux x64, Intel i7-13800H (14 physical / 20 logical cores), 61 GiB RAM,
  shared desktop. .NET SDK 10.0.400, runtime 10.0.11. Load average was below
  1.1 at the start of every timed run.
- Compiler under test: `out/bin/Release/Compiler/gsc.dll` built from
  `a1190b9b7` by the pinned 0.5.212 SDK ("fresh"), and the published
  `~/.nuget/packages/gsharp.net.sdk/0.5.212/tools/compiler/gsc.dll`
  ("published"). Both run the published compiler's code generation for their
  own bodies: a fresh build does not inherit backend changes until it is
  rebuilt by itself (the bootstrap caveat the maintainer records in #2189).
- Inputs:
  - **Core**: the response file MSBuild wrote for `src/Core`
    (`out/obj/Core/Release/GSharp.Core.rsp`: 707 sources, 173 references,
    `/optimize+ /debug:portable /deterministic+ /refout /doc`, the internal
    analyzers, `--workers:1`).
  - **LanguageServer**: `out/obj/LanguageServer/Release/GSharp.LanguageServer.rsp`
    (38 sources, about 15.8k lines).
  - **Hello**: a five-line `Console.WriteLine` program with the same 173
    references, as `.gs` for `gsc` and as `.cs` for `csc` (`/noconfig
    /nostdlib+` with the same reference list minus the three G# runtime
    assemblies).
- Tools: `build/selfhost-bench.py` (interleaved runs, GNU `time`), the
  compiler's own `GSHARP_MEASURE_PHASES` JSON, `dotnet-counters`,
  `dotnet-trace` with the sample profiler, and a small runner script that
  rewrites output paths into a work directory. Output paths were redirected
  so no run wrote into the tree. Work roots were under `~/.cache/`.
- Samples: three or five runs per cell with one excluded warm-up. Medians and
  observed ranges are reported. These are small samples on a shared host;
  they locate costs and order candidates, they are not confidence intervals.

### Source reading

Six read-only passes over the source, one per layer (syntax, binder and
scope, symbols and metadata, flow analysis and nullability, lowering and
emit, driver and SDK and language server), each asked the same questions:
what is mutable, what is walked, what is cached and where, what is
duplicated. Every `file:line` cited below was re-read before it was cited.
Line numbers are for `a1190b9b7`.

## 3. What #2189 has already landed

The tracker's comments record each item's measured outcome. This study does
not re-propose them. The table is the baseline the recommendations build on.

| Issue / PR | Change | Measured outcome (maintainer's numbers) | What it did not do |
| --- | --- | --- | --- |
| #5040 / #5046 | Alias, nested-type and imported-extension candidate indexes; structured phase measurement | Part of the 293 s to 60 s compiler-graph reduction | Did not index the ordinary import scan |
| #5038 / #5048 | Retained-state fix (`ImportedTypeSymbol` cache made weak), bounded compiler worker | Opt-in only; 3.3x to 3.7x late-call latency in the probe | Off by default; serial; retires on analyzers, 16 requests, 256 MiB |
| #5039 / #5049 | Generator-host projection and setup reduction | Part of the Oahu 49.8 s to 30.3 s opt-in reduction | gsgen still re-parses and re-binds declarations |
| #5041 / #5050 | MSBuild-budgeted parse and body workers | Four-worker parse saved 58 to 65 ms; one body qualified on Core | Workers default to 1; eligibility excludes any call |
| #5042 / #5051 | Deterministic method-local emission boundary | No measured emit gain on the pinned Core inputs | Primitive bodies only |
| #5055 / #5058 | Skip rich-anonymous discovery for trees without anonymous objects | 700 walks removed; 667 / 410 MiB less allocation; no speed gain | |
| #5054 / #5057 | Generated-document translation reuses the active semantic model | Oahu rebuild 32.7 s to 29.1 s | |
| #5056 / #5062 | Canonical declaration readers; scalar bodies admitted to workers | Overlapping ranges | Calls and receivers still coordinator-owned |
| #5070 / #5074 | Weak caches for metadata definitions and raw nullable bytes | Scans 47,484 to 389; Core wall 40.95 s to 41.94 s (no gain) | Final `TypeSymbol`s are not cached |
| #5069 / #5078 | Shared file/stream emit preparation | Maintenance only | |
| #5071 / #5079 | Local overload parameter-vector reuse | 61k parameter reads removed; no timed comparison | |
| #5104 / #5106 | Definite-assignment scratch-set reuse | 852 MiB (5.5%) less allocation; wall 43.8 s to 44.6 s | Nested regions still rebuild CFGs |
| #5105 / #5108 | Ordered visible-import views by source tree | **Core 35.4 s to 26.0 s (-26.7%); Core.Tests 71.5 s to 25.2 s (-64.7%)** | |
| #5102 / #5107 | Synchronous iterator first-enumerator reuse | 16.6% less allocation in a self-rebuilt comparison; wall unchanged | Needs the compiler rebuilt by itself to apply to its own bodies |
| #5103 / #5109 | Equivalent SDK publish-graph reuse | Core compilations per clean build 4 to 1 | Repository packaging only |
| #5117 | Pin to 0.5.212 | Whole-solution build 267 s to 164 s (-38.6%) | |

Parked: #5072 / #5077 (shared declaration discovery across semantic models)
was parked by the maintainer because first-query cost regressed. Nothing here
resumes it.

Constraints the maintainer stated that this study keeps:

- Do not split `OverloadResolver.BindCallExpression` on size alone.
- Do not add a second raw-definition cache; #5070's counters show the first
  one is effective (48,480 requests, 405 scans).
- Empty generator manifests do not justify skipping generators.
- No worker count may change semantics or output bytes.
- Pin moves are separate PRs; stage-2 certification is not a PR gate.

## 4. Measurements

All rows in this section are measured on the host in section 2 unless marked
estimated. Wall and CPU are GNU `time` seconds for the `dotnet gsc.dll @rsp`
process; RSS is its maximum resident set. Three runs per cell with one
excluded warm-up unless stated; the parenthesized values are the samples.

### 4.1 Core: published 0.5.212 compiler against the fresh build

`build/selfhost-bench.py`, interleaved, one warm-up each, three runs each.

| Compiler | Wall s median (samples) | CPU s median | Peak RSS MiB |
| --- | ---: | ---: | ---: |
| Published 0.5.212 `gsc.dll` | **27.12** (27.03, 27.12, 28.03) | 30.60 | 1,035 |
| Fresh `gsc.dll` from `a1190b9b7` | **26.67** (26.21, 26.67, 26.96) | 30.18 | 1,034 |

The two are the same compiler for this purpose (ratio 0.98). CPU is 1.13x
wall: the compile runs on one core and the remainder is background GC and
tiered JIT. Every later Core row uses the fresh build.

### 4.2 Phase breakdown (`GSHARP_MEASURE_PHASES`)

One instrumented run each. Counters are process-inclusive, so a nested phase
is part of its parent and the rows are not additive. `count` is how many
times a phase was opened in the compile.

**Core** (27.0 s, 13.2 GiB allocated, 707 sources, 9,212 methods, 176
references; peak working set 1,039 MiB):

| Phase | Count | Wall ms | Alloc MiB | Share of wall |
| --- | ---: | ---: | ---: | ---: |
| `parse` | 1 | 1,796 | 561 | 6.6% |
| `references.setup` | 1 | 42 | 42 | 0.2% |
| `declarations` | 1 | 4,143 | 2,322 | 15.3% |
| &nbsp;&nbsp;`references.type-name-index` | 1 | 200 | 88 | |
| &nbsp;&nbsp;`references.extension-holders` (first opened under `declarations`; later openings are under `bodies`) | **812** | 411 | 112 | |
| &nbsp;&nbsp;`references.extension-name-index` | 1,319 | 55 | 17 | |
| &nbsp;&nbsp;`references.record-shape` | 432 | 44 | 18 | |
| `bodies` | 1 | **15,432** | **7,834** | **57.1%** |
| &nbsp;&nbsp;`bodies.whole-program-analyses` | 1 | 328 | 66 | |
| `documentation.validation` | 1 | 41 | 21 | 0.2% |
| `lowering.*` (ten passes) | 10 | 481 | 262 | 1.8% |
| `emit.implementation` | 1 | 1,713 | 568 | 6.3% |
| &nbsp;&nbsp;`emit.planning` (+ `emit.discovery`) | 2 | 401 (291) | 234 | |
| &nbsp;&nbsp;`emit.debug-directory` (+ `emit.pdb`) | 2 | 50 (47) | 11 | |
| &nbsp;&nbsp;`emit.serialization` | 2 | 54 | 30 | |
| `emit.reference` | 1 | 429 | 221 | 1.6% |
| `documentation.emit` | 1 | 93 | 161 | 0.3% |
| `analyzers` (the internal analyzers over Core) | 1 | **2,439** | 858 | **9.0%** |
| Unattributed (JIT, process start, `using` disposal, exit) | | about 400 | | 1.5% |

Counters of note: `alias.candidate-visits` 51,075; `imports.views-built`
1,310; `metadata.definition-requests` 48,528 against 405 scans (the #5070
cache is effective); `metadata.contract-requests` 101,476 against 6,865
nullable decodes; `records.shape-queries` 18,958 against 432 scans;
`workers.active` 1.

The `references.extension-holders` count is the direct evidence for S1: the
`Assembly.GetTypes()` scan over the reference closure ran 812 times in one
compile because its cache lives on the per-body `BinderContext`. At 0.5 ms
each it is only 0.4 s here; on a project with more references or more
extension-probing bodies it scales with both.

**LanguageServer** (3.5 s, 1.19 GiB allocated, 38 sources): `parse` 143 ms,
`declarations` 871 ms (of which `references.type-name-index` 158,
`references.namespace-index` 78), `bodies` 1,834 ms (52%),
`references.extension-holders` ran 136 times (101 ms), `emit.implementation`
398 ms, `emit.reference` 42 ms. Peak working set 371 MiB.

**Hello** (561 ms, 175 MiB allocated, 1 source, 176 references): `parse` 12
ms, `references.setup` 47 ms, `declarations` **375 ms** (of which
`references.type-name-index` 135 ms, `references.namespace-index` 18 ms),
`bodies` 15 ms, `emit.implementation` 75 ms. Peak working set 228 MiB. About
200 ms of the 561 ms is work that depends only on the reference set; the rest
of `declarations` is the implicit-import and embedded-attribute setup plus
first-call JIT of the binder.

### 4.3 Small program and startup: `gsc` against `csc`

Five runs each, one warm-up. The same 173 reference assemblies, the same
`/optimize+ /debug:portable /deterministic+`.

| Compiler and setting | Wall s median (samples) | CPU s | RSS MiB |
| --- | ---: | ---: | ---: |
| `csc.dll` (ReadyToRun image, shipped with the .NET SDK) | **0.31** (0.31, 0.32, 0.31, 0.31, 0.31) | 0.30 | 106 |
| `gsc.dll` fresh, defaults | **0.56** (0.55, 0.58, 0.56, 0.56, 0.58) | 0.55 | 228 |
| `gsc.dll`, `DOTNET_TieredPGO=0` | 0.53 (0.53, 0.52, 0.54, 0.53, 0.53) | 0.52 | 225 |
| `gsc.dll`, `DOTNET_TieredCompilation=0` | 1.04 (1.07, 1.03, 1.04, 1.04, 1.04) | 1.04 | 241 |

`gsc` is 1.8x `csc` on a one-line program, with 2.1x the memory. `csc` runs
precompiled code; `gsc` JITs everything it touches at Tier 0 and then pays
the reference-closure index (section 4.2). Turning tiering off doubles the
small-program time, as expected for a short process.

### 4.4 Runtime knobs on Core, no code change

Three runs each, one warm-up, same response file. The `--workers:4` row
rewrites the response file's `--workers:1`.

| Variant | Wall s median (samples) | CPU s | RSS MiB | Wall vs baseline |
| --- | ---: | ---: | ---: | ---: |
| Baseline (fresh `gsc`, one worker) | 26.68 (26.86, 26.36, 26.68) | 30.30 | 1,037 | |
| `--workers:4` | 26.54 (26.08, 26.61, 26.54) | 31.54 | 1,033 | -0.5% |
| `DOTNET_gcServer=1` | 26.14 (25.74, 26.80, 26.14) | 33.43 | 1,426 | -2.0% |
| `DOTNET_GCgen0size=0x10000000` (256 MiB gen0) | 26.12 (25.49, 26.12, 26.18) | 29.33 | 1,163 | -2.1% |
| `DOTNET_gcConcurrent=0` | 25.74 (25.74, 25.71, 26.20) | 28.76 | 1,105 | -3.5% |
| **`DOTNET_TieredPGO=0`** | **18.42** (18.77, 18.33, 18.42) | 19.77 | 1,022 | **-31.0%** |
| **`DOTNET_TieredCompilation=0`** | **17.10** (17.10, 17.50, 17.08) | 17.18 | 1,006 | **-35.9%** |

Two results stand out and are re-measured in section 4.5. The GC knobs move
the result by 2 to 3.5%, within what a shared host can produce. Four workers
do nothing on Core, which matches the maintainer's finding that the current
eligibility proof admits almost no Core body (`IndependentBodyClassifier`
rejects every body that contains a call, `Binding/IndependentBodyClassifier.gs:168-285`).

The tiering result says that on a 27-second process with a large hot code
surface, the default tiered JIT (Tier 0, then instrumented Tier 0 for PGO,
then Tier 1) spends about a third of the wall time running un-optimized or
instrumented code. `TieredCompilation=0` JITs every method once with full
optimization and is best for the long compile but doubles the hello-world
time (section 4.3). `TieredPGO=0` keeps tiering, drops the instrumentation
tier, and is slightly faster than the default on hello world too. ReadyToRun
images (P8) attack the same cost from the other side: pre-compiled optimized
code at startup, with tiering still available to re-optimize the hot paths.

### 4.5 Re-measurement of the tiering result

Because a 31% change from an environment variable deserves a second look, the
baseline and `DOTNET_TieredPGO=0` were re-run as five interleaved pairs
(baseline, then PGO off, one compile each, one excluded warm-up at the
start), then as three interleaved pairs with the published 0.5.212 compiler,
then on the LanguageServer input, and the output bytes were compared.

| Pair | Fresh `gsc`, default | Fresh `gsc`, `TieredPGO=0` | Delta |
| --- | ---: | ---: | ---: |
| 1 | 25.00 | 18.82 | -6.18 |
| 2 | 25.75 | 18.57 | -7.18 |
| 3 | 26.71 | 18.78 | -7.93 |
| 4 | 28.14 | 19.36 | -8.78 |
| 5 | 26.08 | 19.28 | -6.80 |
| **Median** | **26.08** (25.00 to 28.14) | **18.82** (18.57 to 19.36) | **-27.8%** |

| Published 0.5.212 `gsc` | Default | `TieredPGO=0` |
| --- | ---: | ---: |
| Three pairs, median (range) | 26.55 (26.15 to 27.22) | 18.87 (18.72 to 20.37) |

| Other variants on Core, three runs | Wall s median (samples) | CPU s |
| --- | ---: | ---: |
| `DOTNET_TieredCompilation=0` | 17.36 (17.42, 17.36, 17.20) | 17.45 |
| `DOTNET_TC_QuickJitForLoops=0` | 20.78 (20.78, 20.63, 20.90) | 22.37 |
| `TieredPGO=0` + `gcConcurrent=0` | 20.49 (20.49, 20.70, 19.37) | 22.15 |
| `TieredPGO=0` + `--workers:4` | 17.97 (18.61, 17.71, 17.97) | 20.52 |

| LanguageServer, three runs | Wall s median (samples) |
| --- | ---: |
| Default | 3.40 (3.44, 3.39, 3.40) |
| `TieredPGO=0` | **2.76** (2.75, 2.76, 2.77) (-19%) |
| `TieredCompilation=0` | 4.09 (4.09, 4.12, 4.06) |

The PGO-off result holds in every pair, on both compilers, and on the
mid-size input. It is not an artifact of one build. Full-JIT
(`TieredCompilation=0`) is faster still on Core but slower on LanguageServer
and twice as slow on hello world, so it is not a default candidate.
`TC_QuickJitForLoops=0` is worse than PGO-off alone. Disabling the concurrent
GC on top of PGO-off gives nothing.

**Output identity.** Core compiled into the same output paths under the
default, `TieredPGO=0` and `TieredCompilation=0` produced byte-identical
implementation DLL, PDB, reference DLL and XML (SHA-256 prefixes
`ff9a7391…`, `cc03f26d…`, `8ab54f4b…`, `38df9350…` in all three). An earlier
comparison across different work directories differed only in the
implementation DLL, because the CodeView debug directory embeds the PDB path;
the reference DLL, which carries no debug directory, was identical there too.

**Where the time went** (phase JSON under `TieredPGO=0`, one run, 18.8 s):
`parse` 1,333 ms (was 1,796), `declarations` 2,302 ms (was 4,143), `bodies`
11,108 ms (was 15,432), `emit.implementation` and the rest proportionally.
Allocation was unchanged (14.0 GiB against 13.2 GiB, within run-to-run
variation). The saving is spread across every phase, which is what a JIT-mode
change looks like: the compiler's hot code reached optimized tiers sooner and
spent less time in instrumented code.

The interpretation for the roadmap: about a quarter of today's Core compile
is the cost of running the compiler's own code un-optimized or instrumented.
P8 (1) removes the instrumentation cost with one project setting; P8 (2)
(ReadyToRun) removes most of the Tier-0 cost for the startup-heavy small
project case the maintainer measured.

### 4.6 GC, JIT and exceptions on the Core compile

`dotnet-counters collect --counters System.Runtime`, one run, defaults
(workstation concurrent GC, tiered JIT with PGO). Rate counters are summed
over the run; size counters are the maximum observed.

| Counter | Value |
| --- | ---: |
| Total allocated | 13.38 GB (matches the 13.2 GiB phase total) |
| Gen0 / gen1 / gen2 collections | 818 / 229 / 2 |
| Total GC pause | about 2 s (7% of wall) |
| Max gen2 heap / LOH / committed | 711 MB / 226 MB / 955 MB |
| Max working set | 1,087 MB |
| JIT: methods compiled / IL bytes / JIT time | 29,954 / 3.86 MB / about 5 s (18% of wall) |
| First-chance exceptions thrown | 3,877 `NotSupportedException`, 860 `ArgumentException`, 33 `FileNotFoundException`, 13 `ReflectionTypeLoadException` |

Three observations:

- **Allocation rate is about 500 MB/s** on one thread. Gen0 collections run
  every 33 ms. The GC itself is cheap (2 s of pause for 13 GB), so the cost of
  allocation is mostly the allocation and the cache misses it causes, not the
  collector. That is why the GC knobs in section 4.4 move the result by only
  2 to 3%. Reducing allocation pays through locality, not through GC pause.
- **JIT time is about 5 s of a 27 s compile**, for 30k methods. The tiering
  result in section 4.4 is consistent with this: the default pipeline JITs
  hot methods up to three times (Tier 0, instrumented Tier 0, Tier 1) and
  runs them un-optimized until the call counts settle. ReadyToRun (P8) and
  disabling PGO instrumentation (P8) are the levers.
- **About 4,700 exceptions are thrown and caught during a successful
  compile.** They come from reflection probes that use exceptions as the
  "not applicable" signal: `Type.IsAssignableFrom` on `TypeBuilderInstantiation`
  (`Symbols/ClrTypeUtilities.gs:204`), `Nullable.GetUnderlyingType` on
  `MetadataLoadContext` types and `GetGenericTypeDefinition` on
  `TypeBuilderInstantiation` (`Symbols/NullableLifting.gs:242, 259`),
  `GetGenericArguments` mid-emit (`Symbols/TypeSymbol.gs:757`),
  `Assembly.Location` on in-memory assemblies (`Symbols/ReferenceResolver.gs:1248,
  1805`), and the emitter's `MethodBodyEmitter.MemberAccess.gs:326, 382` and
  `MethodBodyEmitter.Expressions.gs:1043`. At tens of microseconds each this
  is well under 0.5 s, so it is a cleanliness item (P12) rather than a hot
  spot; it also confirms that `System.Type` is being asked questions it
  cannot answer for MLC and `TypeBuilder` types (section 8).

### 4.7 Sample profile of the Core compile

`dotnet-trace collect --providers Microsoft-DotNETCore-SampleProfiler`, one
run, default JIT mode, converted to speedscope and aggregated per thread
(26.3 s of main-thread samples). Two cautions, both of which the maintainer
recorded for the 0.5.199 profile: the EventPipe sampler records managed
thread time including waits, and the leaf frame is biased toward GC
safepoints (`Thread.PollGCWorker` is the recorded leaf for 62% of samples,
reached from allocation and copy helpers). So the exclusive view says where
the thread next reached a safepoint, not where it spent cycles. The inclusive
view (which compiler frames were on the stack) is the usable signal.

**Inclusive share of main-thread samples, by component** (a sample counts
once per pattern; patterns overlap):

| Frames on the stack | Share |
| --- | ---: |
| `Binder.BindProgram` (body binding) | 56.2% |
| `ExpressionBinder.BindAccessor*` (member access and calls) | 21.7% |
| `StatementBinder.BindIfStatement` | 17.9% |
| `System.Reflection.*` (any reflection frame) | 16.8% |
| `BindGlobalScope` (declarations) | 13.3% |
| `ConversionClassifier.*` | 11.8% |
| `DeclarationBinder.*` | 10.4% |
| `GSharpAnalyzerDriver.*` (internal analyzers) | 9.8% |
| `OverloadResolver.*` | 9.5% |
| `DefiniteAssignmentAnalyzer.Analyze` | 9.3% |
| `ReflectionMetadataEmitter.*` | 8.2% |
| `Parser.*` | 7.2% |
| `MemberLookup.*` | 6.8% |
| `Conversion.*` | 6.5% |
| `BoundScope.*` (scope-chain lookups) | 6.3% |
| `AssignedRootsCollector` (narrowing invalidation walks) | 5.9% |
| `System.Linq.*` | 5.5% |
| `UpdateExternalCallableAliases` + `InvalidateNarrowingsForAssignedVariables` | 6.6% |
| `ClrOverloadResolution.*` | 3.9% |
| `ReferenceResolver.*` | 3.2% |
| `Lowerer.Lower` | 2.5% |
| `SyntaxNode.ComputeSpan` | 2.5% |
| `ImportedTypeSymbol.*` | 2.3% |
| `GetImportedExtensionClasses` | 1.6% |
| `SuspensionInference` + `ManagedReferenceSafetyAnalyzer` + `RefStructAsyncLivenessAnalyzer` | 1.3% |

**Hot runtime helpers and who calls them.** Each row is the share of
main-thread samples that have the helper anywhere on the stack; the caller
column is the nearest compiler frame above it, with its own share. Because
the sampler records the safepoint the thread reached rather than the
instruction it was executing, a helper's share is an upper bound on the cost
of the code around it, not a measurement of the helper itself.

| Helper | Share | Main compiler callers |
| --- | ---: | --- |
| `CastHelpers.Box` (boxing) | 12.4% | `AssignedRootsCollector.AnalyzeCallableArguments` 2.2%, `ExpressionBinder.BuildNarrowedVariableRead` 2.1%, `BoundTreeWalker.VisitList` 1.7%, `AccessPath.GetHashCode` 1.0%, `TypeMemberModel.AddMethodsDeduped` 0.7% |
| `ImmutableArray.Builder.ToImmutable` (copies when capacity differs from count) | 6.7% | `Parser.ParseArgumentsCore` 1.3%, `BindBlockStatement` 0.8%, `StructSymbol.GetMethods` 0.5%, `TypeMemberModel.GetMethods` 0.4% |
| `Stack.PushWithResize` | 5.7% | `Conversion.ContainsPlatformType` 4.9%, `Lowerer.Flatten` 0.6% |
| `List.AddWithResize` + `HashSet.Resize` | 4.4% | spread across binding |
| `RuntimeHelpers.GetHashCode` (reference hashing) | 6.4% | `SyntaxTree.BuildParentIndex` 1.6%, `HashSet.Add` 1.1%, node-keyed `Dictionary` inserts and lookups |
| `Object.MemberwiseClone` via `HashSet.ConstructFrom` (copying a `HashSet`) | 5.8% | `DefiniteAssignmentAnalyzer.ClassifyConditionAssignments` 2.2%, `.ProcessExpression` 1.2%, `.AnalyzeRegion` 0.85%, `AssignedRootsCollector.CaptureCallableState` 1.1% |
| `Monitor.Enter_Slowpath` (lock) | 3.8% | `ImportedTypeSymbol.Get` 1.9% (`lock bucket.Gate`, `Symbols/ImportedTypeSymbol.gs:252`), `ConcurrentDictionary.TryAddInternal` 1.4% |
| `SyntaxNode.GetChildren` iterator `MoveNext` | 3.5% | all syntax walks |
| `SemanticModel.BuildIndex` + `EnumerateDeclaredSymbols` (analyzer host) | 5.7% | `GSharpAnalyzerDriver` |

Three facts fall out that the phase table alone does not show:

1. **`for ... in` over a generic collection of a same-compilation element
   type boxes.** When the element type is symbolic (a compiler-defined type
   or a type parameter), the lowering routes the loop through
   `((IEnumerable<T>)items).GetEnumerator()` to keep the element type in
   symbolic emit (`Lowering/Lowerer.gs:1400-1402, 1485-1576`), which boxes
   the struct enumerator; closed CLR element types already get the struct
   enumerator through `MemberLookup.ResolveGetEnumerator`. Verified by
   decompiling `BoundTreeWalker.VisitList` (`Binding/BoundTreeWalker.gs:828-836`)
   and `RendezvousBatchAnalyzer.Run`. Arrays get an indexed loop. `src/Core`
   has 2,991 `for ... in` loops, most over its own types. This is a
   code-generation finding (P13): extending symbolic emit to the known struct
   enumerators removes an allocation from most loops in the compiler, with
   the bootstrap caveat that the compiler's own loops benefit after the pin
   moves.
2. **Narrowing and definite assignment copy sets.** `HashSet` copy
   construction alone is 5.8% of main-thread samples, split between
   definite assignment (post-#5106, in `ClassifyConditionAssignments` and
   `ProcessExpression`, `Binding/DefiniteAssignmentAnalyzer.gs:464, 1017`)
   and the narrowing collector's `CaptureCallableState`
   (`Binding/StatementBinder.Narrowing.gs:2040-2053`, which copies a
   dictionary of sets plus two sets per capture). P3 and S5 cover both.
3. **`Conversion.ContainsPlatformType` allocates a `Stack` and a `HashSet`
   per call** (`Binding/Conversion.gs:4308-4327`) and is reached often enough
   to be 4.9% of samples through `Stack.PushWithResize` alone. A
   non-allocating walk (recursion with a small fixed-size visited buffer, or
   a cached per-type "contains platform type" bit computed once when the
   type symbol is created) is an S-sized item (P12).

### 4.8 ReadyToRun probe

After the maintainer's decision that R2R is viable (section 10, decision 2),
`gsc` was published once with `PublishReadyToRun=true` (framework-dependent,
`linux-x64`, into a cache directory; `GSharp.Core.dll` grew to 14.0 MB and
carries the `RTR` header) and timed against the JIT build from the same
source. Same response files, one excluded warm-up, five runs for hello and
three for Core, measured back to back on the same host.

| Compiler image | Hello wall s median (samples) | Core wall s median (samples) | Core CPU s |
| --- | ---: | ---: | ---: |
| JIT `gsc` (control, re-measured in this run) | 0.56 (0.56, 0.57, 0.55, 0.55, 0.58) | 26.34 (26.91, 26.32, 26.34) | 29.69 |
| R2R `gsc`, default tiering | **0.39** (0.38, 0.37, 0.40, 0.39, 0.40) | 23.78 (23.11, 23.78, 24.09) | 26.15 |
| R2R `gsc`, `TieredPGO=0` | 0.39 (0.41, 0.36, 0.39, 0.39, 0.39) | **16.94** (16.94, 16.78, 16.99) | 18.03 |

R2R alone takes the small-project compile from 0.56 s to 0.39 s (-30%; `csc`
is 0.31 s on the same input, section 4.3) and Core from 26.3 s to 23.8 s
(-10%, in line with the -8.5% the maintainer measured on the compiler
graph). R2R plus `TieredPGO=0` gives 16.9 s on Core (-36%) and keeps the
0.39 s hello world; the two settings compose. Output identity: Core compiled
into the same output paths by the JIT and the R2R compiler produced
byte-identical implementation DLL, PDB, reference DLL and XML (SHA-256
prefixes `c42256b6…`, `cc03f26d…`, `8ab54f4b…`, `38df9350…`). The publish
also wrote `linux-x64` entries into five `packages.lock.json` files, which
were reverted; Q7 must decide how the R2R payload is restored (a RID-specific
restore or a pre-populated runtime pack) so the lock files stay stable.

## 5. Architecture map

### Pipeline and ownership

```text
 .gs files ──► SourceText ──► Lexer ──► Parser ──► SyntaxTree (one layer, no parent pointer)
                                                       │
 /r: paths ──► ReferenceResolver (MetadataLoadContext) │
                     │ lazy type-name index            │
                     ▼                                 ▼
             Binder.BindGlobalScope  ─────────► BoundGlobalScope  (declarations, shells, bodies of
                     │                                              structs/interfaces, deferred queues)
                     ▼
             Binder.BindProgram  ──► per body: new Binder graph → bind → Lowerer.Lower → AllPathsReturn
                     │                      → DefiniteAssignment → RefStruct liveness → anchor
                     │               whole program: SuspensionInference → Rendezvous → ManagedRefSafety
                     ▼
             BoundProgram ──► PrepareForEmit: 6 program-wide rewrites ──► LowerForEmit: base calls,
                     │                                                       async, iterators
                     ▼
             ReflectionMetadataEmitter.Emit (implementation)  ──► PE + PDB
             ReflectionMetadataEmitter.Emit (metadataOnly)    ──► ref PE
             DocumentationFileEmitter                          ──► XML
                     ▼
             GSharpAnalyzerHost.Run (after emit, on the pre-lowering BoundProgram)
```

Sizes (lines of `.gs`, `a1190b9b7`):

| Layer | Files | Lines | Largest files |
| --- | ---: | ---: | --- |
| `Syntax` | 189 | 32,295 | `Parser.Members.gs` 2,403; `Lexer.gs` 1,638 (11 parser partials, 13,540 lines) |
| `Binding` | 247 | 180,554 | `Binder.gs` 14,223; `MemberLookup.gs` 9,169; `ClrOverloadResolution.gs` 9,582; `ExpressionBinder.Access.MemberLookup.gs` 6,215; `Conversion.gs` 5,855; `ConversionClassifier.gs` 5,391 |
| `Symbols` | 95 | 28,204 | `StructSymbol.gs` 2,977; `ReferenceResolver.gs` 2,160 |
| `Lowering` | 46 | 21,040 | `SpillSequenceSpiller.gs` 2,883; `ExpressionTreeLowerer.gs` 2,480 |
| `Emit` | 56 | 52,972 | `ReflectionMetadataEmitter.gs` 5,465; `UserTokenResolver.gs` 2,713; `StateMachineEmitter.gs` 2,587 |
| `Compilation` | 4 | 1,291 | |
| Other (`Analyzers`, `Documentation`, `Text`, `Execution`, root) | 68 | 16,378 | `DiagnosticDescriptors.gs` 2,580 |
| **`src/Core` total** | **705** | **332,734** | |
| `src/Compiler` | 3 | 1,954 | |
| `src/Sdk` | 76 | 13,861 | |
| `tools/gsgen` | 33 | 9,080 | |
| `src/LanguageServer` | 36 | 15,760 | |

Binding is 54% of the compiler. The `Binder` class itself is one non-partial
14,223-line class (`Binding/Binder.gs:31`; instance members to about line
6408, a `shared` block from 6409 to the end) that wires eight component
objects: `ExpressionBinder` (19 files, about 45.5k lines), `DeclarationBinder`
(7 files, about 15.9k), `StatementBinder` (7 files, about 12.6k) and
`OverloadResolver` (6 files, about 12.2k), plus `MemberLookup`, `Conversion`,
`PatternBinder` and `LambdaBinder`. The constructor
(`Binding/Binder.gs:124-824`) is about 700 lines of closure wiring between
them.

### Data structures that decide the cost profile

| Structure | Design today | Consequence |
| --- | --- | --- |
| Syntax tree | One layer; `SyntaxNode` holds `SyntaxTree`, a boxed cached span and `Kind` (`Syntax/SyntaxNode.gs:22-64`). No parent pointer: `Parent` is a lazily built `Dictionary[SyntaxNode, SyntaxNode]` on the tree (`Syntax/SyntaxTree.gs:17, 64-76, 103-115`). `GetChildren()` is an iterator over per-type accessor arrays built by reflection and compiled expression getters that box each child (`Syntax/SyntaxNode.gs:132-166, 285-325`). | Every subtree walk allocates an enumerator per node and boxes each child; `Span` on first read walks all children (`:214-241`). No incremental reparse is possible without rebuilding every node-keyed map (87 such maps in `src`). |
| Tokens and trivia | Whitespace, comments and bad tokens are full `SyntaxToken` objects that the parser then drops (`Syntax/Parser.gs:118-133`); identifiers are substringed before interning (`Syntax/Lexer.gs:1572-1581`); comments build a `StringBuilder` per character for `Value` (`Lexer.gs:466-557`). The whole file is lexed into a `List` and copied to an `ImmutableArray` (`Parser.gs:131-133`). | Parse is cheap in absolute terms (1.2 s of 27 s on Core) but allocation-heavy; `SyntaxNode.GetChildren` alone was 16.6% of all compiler allocation in the maintainer's 0.5.199 profile. |
| Scope chain | `BoundScope` keeps its own entries and walks `Parent` for every lookup (`Binding/BoundScope.gs:170-180, 530-550`). Ambient package, file and construction hint are `AsyncLocal` fields on the root (`:73, 81, 94`) and every read recurses to the root (`:1806, 1816, 1825`). The import index is reached by recursing to the root on every `EnumerateImports` (`:2650-2672`). | Lookup cost is O(depth) per name and the root walk repeats per read. #5108's import view removed the dominant scan; the chain walk remains. |
| Metadata model | `MetadataLoadContext` over the user references plus the whole host TPA list (`Symbols/ReferenceResolver.gs:1437-1452`); every file is read into a `byte[]` up front (`:1061-1083`); the type-name index materializes every type with `GetTypes()` and `GetForwardedTypes()` (`:1753-1786`); member enumeration resolves every member's signature types on first touch (`Symbols/ClrTypeUtilities.gs:329-360`). | Per-process cost that depends only on the reference set, about 0.2 s of a 0.56 s hello-world compile; and `System.Type` identity is by assembly-qualified-name string (`Emit/TypeIdentityComparer.gs`). |
| Symbol identity | `SymbolEqualityComparer` is reference equality; source generics intern through `TypeArgsKey`; imported constructed generics are not interned (`Symbols/ImportedTypeSymbol.gs:283-306`; the comment says the omission is a choice), and `Binder.SubstituteType` has no memo (`Binding/Binder.gs:12854-13050`). | Equal imported constructions are distinct objects, so token caches keyed by symbol identity miss (`Emit/MetadataTokenCache.gs:440-537`) and substitution is repeated. |
| Bound tree | About 110 `Bound*` node classes (classes deriving from a `Bound*` base, in 104 files), 103 `BoundNodeKind` values. `BoundTreeRewriter` is identity-preserving for most nodes (`Binding/BoundTreeRewriter.gs:95-114`). Dispatch is by `switch node.Kind` in 5 files (308 arms) and by type pattern in 57 files (793 `case x is BoundY` arms, 1,590 `is BoundX` tests). | Adding a node kind touches about 60 files. Function-literal bodies are never rewritten by the shared rewriter (`:2253-2255`), which forces each pass to lower lambdas separately. |
| Emit state | One `MetadataBuilder` and one IL `BlobBuilder` per emit (`Emit/EmitContext.gs:45-54`); `MetadataTokenCache` has about 35 dictionaries, several keyed by `Type` through the AQN-string comparer (`Emit/MetadataTokenCache.gs:52-104`); 303 `BlobBuilder()` construction sites, no pooling. | Emit is 6% of Core wall time today, so this is not the next target; it matters for the parallel-emit plan (#5042) and for allocation. |

### Where the batch path carries language-server and REPL weight

`src/Core` holds about 2,400 lines that exist only for the language server or
the REPL: `BoundBodyCache` (221 + 32), `IncrementalGlobalScopeReuse` (635),
`SubmissionImports` (364), `SubmissionGlobalTypeProjection` (149),
`ReferenceMetadataIndex` (308, used only by the language server),
`Execution/InteractiveSessionHost` (219). Submission handling is inlined in
`Binder.BindGlobalScope` (`Binding/Binder.gs:6576-6651, 7238-7349`) and in
`ExpressionBinder.Assignments.gs:4894-5230` (about 337 lines of
submission-global write handling). One of these paths costs the batch compiler
time: `BindBodyWithCache` computes `ContainsSyntheticBodySideEffects`, a full
recursive `GetChildren()` walk of the body, before it checks whether a cache
exists (`Binding/Binder.gs:8460-8461, 8478-8491`). `gsc` never has a cache.

## 6. Simplicity and code quality findings

Each finding has: the problem, the evidence, the proposed change, the expected
gain, the risk, an effort estimate (S: one agent, one PR, under a week; M: one
PR, one to two weeks; L: several PRs), and its N-1 / bootstrap exposure.
Structural changes to the compiler are compiled by the pinned compiler, so none
of these may use a language feature newer than 0.5.212 (N-1). Changes to emit
or lowering also carry the bootstrap caveat: the compiler's own bodies only
pick up a codegen change after the pin moves past it.

### S1. The `Binder` is constructed per body and is not a service

**Problem.** `Binder` is one 14k-line class with a 700-line constructor that
wires eight components through closures, and a new one is built for every
body (`Binding/Binder.gs:8006, 8739, 8800, 8861, 8923, 9002`; also `:1012` for
rich anonymous objects, `:8342` for suspension adapters, `:9060` for
language-server inference). Each one owns a `BinderContext` with about 20
collections (`Binding/BinderContext.gs:109-131`). Compilation-wide caches
(imported extension holders, static-import types, closure assigned names)
live on that per-body `BinderContext` (`BinderContext.gs:96-103, 395-415`), so
they are rebuilt per body.

**Evidence.** `MemberLookup.GetImportedExtensionClasses` iterates
`assembly.GetTypes()` over every reference assembly and probes attributes per
type (`Binding/MemberLookup.gs:387-470`); its cache test reads six
`binderCtx.CachedImportedExtension*` properties (`:395-409`). A body that
probes an extension method pays the scan again unless the previous body's
context happens to be reused. The phase name `references.extension-holders`
is already measured; see section 4 for the count on Core.

**Proposal.** Split `Binder` into (a) a per-compilation `BindingServices`
object that owns everything keyed by compilation, reference set or syntax
tree (import views, extension-holder index, static-import types, record-shape
classification, the deferred constraint queue), and (b) a small per-body
`BodyBinder` that owns diagnostics, scope frames, narrowing state and
counters. The component wiring moves to the services object and is done once.
This is the shape ADR-0203 §4 already asks for ("worker-local binder state"),
and it is the prerequisite for widening body-worker eligibility.

**Gain.** Removes the per-body closure graph and the repeated extension scan.
Estimated: several percent of body-binding time on Core; the exact share is
in the `references.extension-holders` phase count (section 4). Simplicity
gain is the larger one: `Binder.gs` loses its constructor and most of its
`shared` block becomes methods on the services object.

**Risk.** Medium. The split touches every component's constructor signature.
Behavior must not change; the ADR-0154 witness is byte-identical outputs and
diagnostics on Core, Core.Tests and Oahu. **Effort**: L (three PRs: extract
services; move caches; remove the per-body wiring). N-1: ordinary source.

### S2. Nullability consumers are still open-coded (ADR-0193 Phase 3 has not landed)

**Problem.** ADR-0193 planned a type-level query API and a GSA0008 analyzer
so consumers stop testing wrapper types directly. Only `ReferenceNullability`,
`GetElementPositions` and `StripToBareShape` exist
(`Symbols/TypeSymbol.NullabilityQueries.gs:42, 98, 193`). `AdmitsNil`,
`IsStatedNullable`, `StripReferenceNullability`, `JoinReferenceNullability` and
GSA0008 do not exist in `src`.

**Evidence.** 685 `is`/`as` tests against `NullableTypeSymbol`,
`PlatformTypeSymbol` or `NullabilityAnnotatedTypeSymbol` on 654 lines in 99
files, by this study's count
(`grep -rEo "(is|as) (not )?(NullableTypeSymbol|PlatformTypeSymbol|NullabilityAnnotatedTypeSymbol)\b" src/Core`);
ADR-0193 counted 503 on 482 lines in 80 files with its own method, so the
two numbers show direction, not an exact delta. By directory: Binding
414, Emit 144, Symbols 84, OverloadResolution 26. Top files: `Conversion.gs`
56, `ExpressionBinder.Operators.gs` 46, `MemberLookup.gs` 38,
`MethodBodyEmitter.Conversions.gs` 35, `ConversionClassifier.gs` 29. Thirteen
separate strip/unwrap helpers exist (`Symbols/PlatformTypeSymbol.gs:124`,
`TypeSymbol.NullabilityQueries.gs:193`, `Symbols/Display/SymbolDisplay.gs:860`,
`Emit/MethodBodyEmitter.Conversions.gs:1511`,
`Binding/DeclarationBinder.Functions.gs:3068`, `Binding/Conversion.gs:2616,
4139, 4473`, `Binding/StatementBinder.Conditionals.gs:1560`,
`Binding/MemberLookup.gs:7867`) and three separate join functions
(`ExpressionBinder.Operators.gs:2944`, `ExpressionBinder.SwitchExpr.gs:258`,
`LambdaBinder.gs:3771`). About 20 distinct "is this nullable" entry points
exist across `ClrNullability`, `NullabilityImportRule`, `NullableLifting`,
`NullableFlagsBuilder`, `ReflectionMetadataEmitter`, `MapTypeSymbol`,
`MethodBodyEmitter.Conversions`, `ClrOverloadResolution` and
`OverloadResolver.Candidates`. The imported readers
`ClrNullability.Get{Property,Field,Return,Parameter}TypeSymbol`
(`Symbols/ClrNullability.gs:69, 122, 147, 178`) rebuild a new
`NullabilityAnnotatedTypeSymbol` on every call (`:772, 783, 799`; 111 call
sites), because that wrapper has no interning (`internal init`, 10 direct
construction sites).

**Proposal.** Finish ADR-0193 Phase 3 as written. The ADR requires the phase
to land as one atomic PR
(`docs/adr/0193-nullability-queries-are-type-level-and-funnelled.md:1275-1282`):
GSA0008 analyzes the whole compilation, so the query members, the analyzer in
`src/Analyzers/InternalAnalyzers` beside GSA0007, and the full consumer
migration (about 80 files; the five files above are the largest slices) land
together, with the diff grouped by ownership for review. Collapse the 13
strip helpers onto `StripReferenceNullability(deep)` and the three joins onto
`JoinReferenceNullability` in that same PR. Interning
`NullabilityAnnotatedTypeSymbol` by `(inner, flags)` the way
`NullableTypeSymbol.Get` already does, or caching the decoded signature
symbol per `MemberInfo` (P5 below), changes no consumer and can land before
it as its own PR.

**Gain.** Mostly simplicity and defect rate (the ADR records that independent
nullability computations are the most frequent root cause). The interning is
also an allocation win: `TypeSymbol.GetWrappedTypes` was 9.8% of compiler
allocation in the 0.5.199 profile and the annotated wrapper is one of its
inputs. **Risk.** Low per file once GSA0008 enforces the funnel; the ADR's
settled decisions must not be reopened. **Effort**: L, one atomic PR for the API,
the analyzer and the migration (as the ADR budgets), plus an optional S-sized
interning PR before it. N-1: ordinary source.

### S3. Two conversion systems and two member-lookup systems

**Problem.** `Conversion.gs` (5,855 lines) and `ConversionClassifier.gs`
(5,391) both classify conversions; `MemberLookup.gs` (9,169, CLR members) and
`ExpressionBinder.Access.MemberLookup.gs` (6,215, source members) both look up
members; `ClrOverloadResolution.gs` (9,582) and `OverloadResolver.*.gs` (6
files, about 12.2k) both resolve overloads. ADR-0112 added
`Symbols/TypeMemberModel.gs` (1,117 lines) for source members and did not
reach the CLR side.

**Evidence of drift.** `MemberLookup.ClassifySymbolicIndexerConversion` and
`TryClassifyConstructedGenericConversion` (`Binding/MemberLookup.gs:6407-6500+`)
re-implement conversion classification for symbolic indexers with their own
same-type predicate `SameTypeSymbol` (`:7195`); the comment at `:6421-6497`
records three rounds of drift fixes, and `Conversion.gs:168-233` exposes three
helpers specifically so that `MemberLookup` can "ask the same question instead
of restating the rule". Indexer signature equality exists twice
(`ExpressionBinder.Access.MemberLookup.gs:2036-2059` on symbols;
`MemberLookup.gs:6361-6376` on `PropertyInfo`). Callable signature equality
exists four times (`ExpressionBinder.Access.MemberLookup.gs:5472-5503,
5048-5100`; `MemberLookup.gs:1252-1277`; `BoundScope.gs:2723`). "Self plus
interfaces" enumeration exists three times with different semantics
(`Conversion.gs:2997-3002` via `SafeGetInterfaces`; `MemberLookup.gs:716-721`
via raw `GetInterfaces`; `Binder.gs:13897-13904` yields self only when it is an
interface). Numeric widening is checked three ways (`Conversion.gs:5431-5470`;
`ConversionClassifier.gs:4726-4739`).

**Proposal.** Do not merge the big files. Instead, name one owner per
question and make the others call it: `Conversion` owns classification
(delete the `MemberLookup` copies and route through the `:168-233` helpers,
which already exist for this); one `SignatureEquality` helper owns the four
callable/indexer equalities; one `TypeHierarchy.EnumerateSelfAndInterfaces`
with an explicit `includeSelfWhenClass` flag replaces the three. Each is an
S-sized PR with byte-identical output as the witness. The larger unification
(a `TypeMemberModel` that fronts CLR members too, so `MemberLookup` becomes
an implementation detail) is the right end state but depends on P5 to P7
making CLR members cheap to model.

**Gain.** Simplicity and defect rate; no speed claim. **Risk.** Low per PR.
**Effort**: S each, three to five PRs. N-1: ordinary source.

### S4. The same analysis questions are answered by many walkers

**Problem.** Lowering and analysis are organized as independent passes, each
with its own tree walker, and nothing memoizes a per-body fact.

**Evidence.**
- "Does this body yield?" is computed by `IteratorDetection.ContainsYield`
  from `BaseCallForwarderRewriter.gs:734`, `Iterators/IteratorRewriter.gs:133`,
  `Suspension/SuspensionInference.gs:359` (inside the fixed-point loop, so
  once per candidate per iteration), `ManagedReferenceSafetyAnalyzer.gs:250`
  and `AsyncIteratorDetection.gs:44`.
- Four purity predicates: `SideEffectAnalyzer.HasObservableSideEffect`
  (`Lowering/SideEffectAnalyzer.gs:42`), `SideEffectSpiller.IsStableLocalRead`
  (`:815`), `RefInitializationHoister.IsTriviallyRepeatable`
  (`Lowering/Async/RefInitializationHoister.gs:384`),
  `ExpressionBinder.IsSideEffectFreeForHandlerCapture`
  (`Binding/ExpressionBinder.Literals.gs:3953`).
- Nine capture collectors (`LambdaBinder.gs:2969, 2678`;
  `GoCapturedVariableCollector.gs:28`, run at bind
  `StatementBinder.Blocks.gs:989` and again at emit `ClosureEmitter.gs:443`;
  `CaptureBoxingRewriter.gs:139`; `AsyncCaptureWalker.gs:72, 161`;
  `Binder.gs:3699`; `ClosureEmitter.gs:708`;
  `Emit/LambdaEnclosingTypeParameterCollector.gs:23`).
- Three spill layers with the same goal (stop re-evaluation):
  `SideEffectSpiller` (`Compilation.gs:657`), `SpillSequenceSpiller`
  (`Lowering/Async/SpillSequenceSpiller.gs:2830, 2845, 2857`) and the
  emit-time scratch slots (`Emit/MethodBodyPlanner.gs:368-460`).
- Lambda bodies are lowered and discarded by `DefiniteAssignmentAnalyzer.gs:90`,
  `RefStructAsyncLivenessAnalyzer.gs:184` (for every literal in every body,
  before the async check at `:189`), `LambdaBinder.gs:2117, 3665` and
  `OverloadResolver.Candidates.gs:1813`, and then lowered for real at
  `ReflectionMetadataEmitter.gs:1234, 1241` or `ClosureEmitter.gs:647`.
- Four walkers are `BoundTreeRewriter` subclasses used only to collect
  (`CaptureBoxingRewriter.CaptureWalker`, `IteratorRewriter.NestedIteratorCollector`,
  `AsyncCaptureWalker`, `LambdaBinder.CapturedVariableCollector`).

**Proposal.** Introduce a `BodyFacts` record computed once per lowered body
and attached to the `BoundProgram` entry: contains-yield, contains-await,
contains-fixed, contains-goto-or-label, captured variables per lambda,
has-anonymous-object. Every consumer above reads the record. Replace the
four purity predicates with `SideEffectAnalyzer` plus named options. Lower
each lambda body once and store the result on the `BoundFunctionLiteralExpression`
(or in `BodyFacts`) for the later consumers.

**Gain.** Removes roughly 8 to 12 of the 35 to 45 walks per body (estimated;
section 6, S6). Simplicity: one definition of each fact. **Risk.** Low to
medium; the facts are pure functions of the lowered body, and the witness is
unchanged output and diagnostics. **Effort**: M, two PRs (facts record;
lambda single-lowering). Bootstrap: none for the facts; the lambda change is
lowering and so the compiler's own lambdas only benefit after a pin move.

### S5. Flow analyses build incompatible graphs

**Problem.** There are three CFG shapes and at least two CFGs per plain
method: definite-return projects regions, clones `finally` per exit and
treats throws as terminators (`Binding/ControlFlowGraph.gs:536-542, 649-893`);
definite assignment treats compound statements as opaque and recurses into
regions with a fresh CFG per region (`DefiniteAssignmentAnalyzer.gs:235;
727, 770, 787, 821, 857, 899, 1034, 1625`), rebuilt on every outer fixed-point
iteration and again in the reporting pass (`:350-369`);
`RefStructAsyncLivenessAnalyzer` uses `Lowerer.Flatten` (`:288`). The
narrowing pass builds one more CFG per loop with active narrowings at bind
time and may bind the loop body twice (`StatementBinder.Jumps.gs:241-414`;
`StatementBinder.Narrowing.gs:439-489`).

**Proposal.** One region-aware CFG per lowered body, built once, with
explicit exception edges, consumed by definite-return, definite assignment,
and liveness. Definite assignment keeps its fixed point but stops rebuilding
nested graphs. This is the precondition for S7.

**Gain.** Allocation (the maintainer measured 4.4 GiB of `HashSet` churn in
definite assignment before #5106) and simplicity. **Risk.** Medium: the
region projection encodes language rules about `finally` and `throw`, and the
witness must include the dataflow oracle tests. **Effort**: L. N-1: ordinary
source.

### S6. Lowering is many unfused program-wide passes

**Problem.** A plain method body is walked roughly 35 to 45 times between
parse and IL (estimated from call sites; not measured):

| Stage | Walks | Source |
| --- | ---: | --- |
| Bind-time `Lowerer.Lower` | 5 rewrites + 3 `Flatten` copies | `Lowering/Lowerer.gs:1153-1192, 1245-1251`; `ProtectedRegionBranchRewriter` runs twice (`:1155, 1190`) |
| Bind-time analyses | ~5 walks + 1 to 2 CFGs | `Binder.gs:8745-8761, 8945-8961` |
| Per statement during binding | 2 to 3 subtree walks per statement per enclosing block | `StatementBinder.Narrowing.gs:220-262, 317-333`; `StatementBinder.gs:696-740` |
| Whole program | 3 to 5 | `SyntaxAnchoringWalker` (`Binder.gs:8309-8319`), `SuspensionInference` collector and rewriter over every body (`SuspensionInference.gs:87-89, 145-159`), `RendezvousBatchAnalyzer` unconditional (`RendezvousBatchAnalyzer.gs:171-173`), `ManagedReferenceSafetyAnalyzer` |
| `PrepareForEmit` | 6 full rewrites | `Compilation.gs:633-681`: interpolated strings, initialization, side effects, capture boxing (`ManagedAliasPlanner` + `CaptureWalker`), managed references, expression trees |
| `LowerForEmit` | 4 | base calls (`ContainsYield` + rewriter), iterators (`ContainsYield` + `NestedIteratorCollector`) |
| Emit | 2 program-wide + ~17 planner collectors + 1 emit walk + IL rescan | `Emit/SlotPlanner.gs:88-208`; `Emit/MethodBodyPlanner.gs:198-526`; `Emit/MaxStackTracker.gs:80` |

Each program-wide pass rebuilds the function map and re-sorts it through
`BoundProgramOrder.Functions` (`Binding/BoundProgramOrder.gs:23-29`; 11 call
sites). The synthesized entry point's block is the same object as
`program.Statement` (`Binder.gs:8276`) and three passes rewrite it twice
(`SideEffectSpiller.gs:778/782`, `InterpolatedStringHandlerLowerer.gs:745/749`,
`ExpressionTreeLowerer.gs:2135/2139`); only `ManagedReferenceLowerer.gs:374-379`
checks for it. `RewriteBlockStatement` drops `PreEmitAnalysisBody` on rebuild
(`BoundTreeRewriter.gs:114`) although `SuspensionInference.gs:162` relies on
it surviving.

**Proposal.** (1) Make `PrepareForEmit` one pass per body: a
`LoweringPipeline` that takes the ordered function list once and applies the
six rewriters to each body in sequence, so the map is built and sorted once
and the entry-point aliasing is handled once. (2) Gate each rewriter on a
`BodyFacts` bit (S4) so bodies without interpolation, captures, managed
references or expression trees are not visited. (3) Fold the two
`ProtectedRegionBranchRewriter` runs into one when `FinallyExitRewriter` made
no change.

**Gain.** Lowering is under 3% of Core wall time, so the speed gain is small
in absolute terms; the allocation gain is larger (every rewrite of an
unchanged body is free only when the identity-preserving path is taken, and
`Flatten` always copies, `Lowerer.gs:1739-1790`). The simplicity gain is one
place that defines pass order. **Risk.** Low; pass order is preserved.
**Effort**: M. Bootstrap: lowering change; the compiler's own binaries pick
it up after the next pin move, but the compile-time gain applies at once.

### S7. Narrowing is a scope-stack interpreter, not a dataflow pass

**Problem.** Nullability narrowing (smart casts) is a stack of mutable
`Dictionary[AccessPath, TypeSymbol]` frames in `BinderContext`
(`Binding/BinderContext.gs:125, 333`), pushed per statement list and per
branch, read by expression binding to decide types
(`Binding/ExpressionBinder.gs:886-925`), and joined after the fact by an
interpreter that re-walks the bound branches
(`StatementBinder.Narrowing.gs:1194-1395`; the code says "Without a CFG,
retain only entry facts" at `:1346-1347`). Loops snapshot about 20 structures,
bind the body, lower it, build a CFG, and bind the body a second time when an
inherited narrowing is invalidated (`StatementBinder.Jumps.gs:284-413`).
`StatementBinder.Narrowing.gs` is 4,301 lines; `AssignedRootsCollector` alone
is about 940 of them (`:1498-2440`).

**Why a Roslyn-style post-bind `NullableWalker` does not transfer directly.**
In C#, nullable flow state produces warnings only; the bound tree's types do
not change. In G#, the narrowed type is the type: member lookup, overload
resolution, conversions and emit all consume it (`ExpressionBinder.gs:925`).
A post-bind pass would have to re-bind under the narrowed types. So the
realistic simplification is not "move narrowing after binding" but "compute
narrowing facts once and stop re-walking":

**Proposal.** (1) Compute one per-statement effect summary (assigned roots,
member-mutating calls, callable aliases) when the statement is bound, store
it on the `BoundStatement`, and have `InvalidateNarrowingsForAssignedVariables`,
`UpdateExternalCallableAliases` and `ApplyIfJoinNarrowings` read it instead
of walking (`StatementBinder.Narrowing.gs:249, 260-261, 330`;
`StatementBinder.gs:696-737`). (2) Replace the if-join interpreter with a
join over the frames the branches were bound under. (3) Keep the loop
re-bind but make its invalidation check read the summaries. The full
redesign (per-variable flow state computed once, with binding consuming it
through a query) is a language-semantics project in corner cases; the
maintainer approved it (section 10, decision 3), so it proceeds as an ADR
plus the pass, after the summaries land (roadmap M1a then M1b).

**Gain.** Removes the O(depth x size) per-statement walks, which are inside
the 65% body-binding phase; the exact share needs a profile with the
summaries in place (section 4 lists the current narrowing-related frames in
the sample profile). **Risk.** Medium; narrowing semantics are
diagnostic-visible and have a large conformance suite, which is the witness.
**Effort**: M for (1), M for (2). N-1: ordinary source.

### S8. Syntax layer: reflection-built child access and no trivia model

**Problem.** `GetChildren()` is an iterator over per-type accessors that were
built by reflection over public properties and compiled as boxing expression
getters (`Syntax/SyntaxNode.gs:132-166, 296-325`). Child order is "C#
declaration order", which is not source order, so `Span` must take min/max
over all children (`:214-241`). There is no trivia model: whitespace and
comments are tokens the parser discards (`Syntax/Parser.gs:126-129`).
Immutability is a convention: 14 node files have settable properties and
`InvalidateCachedSpan()` is called from 75 sites.

**Proposal.** Generate `GetChildren` (and a non-allocating
`ChildCount`/`GetChild(i)` pair) per node class from the node definitions,
in source order, and make `Span` first-child-start to last-child-end. The
G# compiler has no syntax generator today; a small Python or G# generator
under `build/` that emits a partial per node class is enough. Keep the
reflection path as the test oracle for one release. Do not add a red/green
split now (section 8 explains why it does not pay for the batch compiler
yet).

**Gain.** `SyntaxNode.GetChildren` was 16.6% of all compiler allocation
(0.5.199 profile); a generated non-iterator walk removes the enumerator and
the boxing. Simplicity: the node shape is declared once. **Risk.** Low; order
changes are observable only through `GetChildren` consumers, and
`GetChildPropertiesInEnumerationOrder` already exists as a test hook.
**Effort**: M. N-1: generated source must compile with 0.5.212.

### S9. Smaller cleanups

| Item | Evidence | Proposal | Effort |
| --- | --- | --- | --- |
| `ContainsSyntheticBodySideEffects` runs for every body in `gsc`, which has no body cache | `Binding/Binder.gs:8460-8461` | Test `cache != nil` first | S |
| `SyntaxFacts.GetUnaryOperatorKinds`/`GetBinaryOperatorKinds` call `Enum.GetValues` on each call | `Syntax/SyntaxFacts.gs:394, 405` | Static arrays | S |
| `TextLocation` recomputes the line binary search for each of `StartLine`, `StartCharacter`, `EndLine`, `EndCharacter` | `Text/TextLocation.gs:39-51` | Compute once per diagnostic | S |
| `SplitQuestionOpenBracketToken` copies the whole token array | `Syntax/Parser.gs:576-581` | Lex `?[` as two tokens with a parser-side fuse, or use a mutable builder | S |
| `BindProgram` makes eight separate loops over `globalScope.Structs` | `Binding/Binder.gs:7832, 7983, 8034, 8052, 8132, 8168, 8216, 8268` | One loop with an ordered member list per struct | S |
| `CaptureTypeAliasIndex`/`CaptureNestedTypeAliasIndex` have no production caller | `Binding/BoundScope.gs:1972, 1990` | Remove or use | S |
| Three `TypeContainingType`/`Definition`/`Arity` helper sets | `Binding/BinderContext.gs:524-558` vs `BoundScope.gs:2787, 2905, 2913` | One helper | S |
| `GetDeclaredInterfaces`/`Enums`/`Delegates` rebuild arrays per call; only `GetDeclaredStructs` is memoized | `Binding/BoundScope.gs:1470-1493` | Memoize all four behind one publish | S |
| Stale comment says interpolation holes cost a nested `SyntaxTree.Parse` | `Syntax/Lexer.gs:1590-1592` | Fix the comment | S |
| `ImportedClassSymbol` is constructed uncached at 48 sites | `Symbols/ImportedClassSymbol.gs:19` | Intern per `(Type, context)` | S |

## 7. Performance findings

Ordered by expected gain per unit of risk. Gains are estimates unless a row
cites a measurement. Where a finding is the performance face of a structural
finding in section 6, it says so and does not repeat the evidence.

### P1. Build binder services once per compilation (the performance face of S1)

**Problem.** Per body: a new `Binder` graph, a new `BinderContext` with about
20 collections, and recomputation of compilation-level caches that live on
that context. **Evidence.** `references.extension-holders` opened 812 times
on Core and 136 times on LanguageServer (section 4.2); the sample profile
shows `Binder+<closure_...>.Invoke` frames as the entry to every body
(section 4.7), and `BindBodyWithPackage` at 30% inclusive. **Change.** S1's
`BindingServices` split; move `CachedImportedExtension*`, static-import types
and record-shape classification onto it. **Gain.** Estimated 2 to 5% of body
binding on Core from the removed scans and allocations; larger on
reference-heavy applications (Oahu has 352 references). **Risk.** Medium
(structural). **Effort.** L. **Dependencies.** None; unblocks P4 and P11.

### P2. Index imported extension holders once per (reference set, import set)

**Problem.** `GetImportedExtensionClasses` iterates `assembly.GetTypes()`
over every reference and probes `IsStaticClass`, `HasExtensionAttribute`
(uncached `GetCustomAttributesData`, `Binding/MemberLookup.gs:4742-4752`) and
visibility per type (`:424-456`). Its validity test compares the import list
with `SequenceEqual` and the referencing tree by identity (`:406-409`), so a
compile with N files rebuilds it at least N times. **Change.** A
compilation-owned `ImportedExtensionHolderIndex` keyed by namespace, built
once per reference set from the type-definition table, filtered per import
set by dictionary lookup. This is the "name-indexed imported-extension
candidate cache within the correct reference/import context" that ADR-0203
§2 asked for; #5040 indexed the methods per holder but kept the per-context
holder scan. **Gain.** Removes the 812 scans (0.4 s on Core; estimated 1 to 3
s on Oahu-sized reference sets, where ADR-0203 measured 0.66 s of extension
collection in an 8.4 s trace before #5040). **Risk.** Low; the filter rules
(accessibility, friend assemblies, same-file imports) move unchanged.
**Effort.** S to M. **Dependencies.** Independent of P1.

### P3. One effect summary per statement for narrowing (the performance face of S7)

**Problem.** Per statement, with narrowings active: one syntax walk
(`CollectAssignedNamesAndMemberMutation`) and one bound walk
(`AssignedRootsCollector`) in `InvalidateNarrowingsForAssignedVariables`, and
one unguarded bound walk in `UpdateExternalCallableAliases`
(`Binding/StatementBinder.Narrowing.gs:249, 260-261, 330`). Each
`AssignedRootsCollector` allocates about 15 collections (`:1501-1534`).
Because the enclosing block repeats the walk for its own statement list, the
cost is O(depth x size). `ApplyIfJoinNarrowings` re-walks both branches
per `if` (`:1194-1395`). **Evidence.** In the sample profile,
`BindStatementWithNarrowing` is 8.3% inclusive and `BindIfStatement` 9.9%
(section 4.7); the body-binding phase is 57% of wall. **Change.** Compute
assigned roots, member-mutating calls and callable aliases once when the
statement is bound and store them on the `BoundStatement`; read them in the
three consumers; join `if` from the bound-under frames. **Gain.** Estimated
5 to 10% of body binding; a profile with the summaries in place will say.
**Risk.** Medium; the conformance suite for narrowing is the witness.
**Effort.** M. **Dependencies.** None.

### P4. Widen body-worker eligibility behind P1

**Problem.** `--workers:4` changes nothing on Core (section 4.4) because
`IndependentBodyClassifier` rejects every body with a call, a member access,
a lambda, a receiver or a non-primitive type
(`Binding/IndependentBodyClassifier.gs:23-46, 65-153, 168-285`). The
maintainer's design (ADR-0203 §4, #5041, #5056) requires a proof of shared
state safety before widening, not a denylist. **What blocks the proof.**
Shared mutable synthesis state reached through `SynthesisParent`
(`BoundScope.gs:110-119, 1540-1710`): `AnonymousTypeCache` and
`SynthesizedRefDelegateCache` use plain dictionaries and a `counter++` that
makes synthesized names depend on bind order (`SynthesizedRefDelegateCache.gs:24-26,
52`); `StructuralAdapterRegistry` and the rich-anonymous plans are plain
collections; the memo fields at `BoundScope.gs:101-105` are written
non-atomically; `ImportedTypeSymbol.Get` holds a lock per bucket
(`Symbols/ImportedTypeSymbol.gs:252`). **Change.** (1) Key synthesized
artifacts by a stable owner identity (declaring symbol plus syntax position),
not by a counter, so two workers that synthesize the same shape produce the
same name; (2) make the synthesis caches publish-first concurrent maps or
defer synthesis to a serial merge after the body barrier; (3) with P1 in
place, give each worker its own `BodyBinder` over the shared immutable
services. Then admit bodies that contain calls to already-bound declarations
and imported members. **Gain.** This is the only path to a multi-core body
phase; Amdahl on Core gives at most 15.4 s / N for the body phase, so four
workers could remove up to 10 s of 27 s if eligibility reached most bodies
(estimate, not a forecast). **Risk.** High; determinism and output identity
at every worker count are the gates (ADR-0203 §4 and gate 4). **Effort.** L,
three PRs. **Dependencies.** P1; stable synthesized names must land first as
their own PR with byte-identical output as the witness.

### P5. Cache decoded imported signatures and intern imported constructions

**Problem.** `ClrNullability.Get{Property,Field,Return,Parameter}TypeSymbol`
rebuild a `TypeSymbol`, apply nullability and tuple names, and allocate a new
`NullabilityAnnotatedTypeSymbol` on every call (`Symbols/ClrNullability.gs:69,
122, 147, 178; 772, 783, 799`; 111 call sites). `ImportedTypeSymbol.GetConstructed`
is uncached and builds a `string.Join` name per call
(`Symbols/ImportedTypeSymbol.gs:283-306`; 60 call sites);
`Binder.SubstituteType` has no memo and calls `MakeGenericType` on the
imported path (`Binding/Binder.gs:12854-13050`); `MapOpenClrTypeToSymbolic`
runs `RequiresSymbolicProjection` (three `GetWrappedTypes` walks) per generic
argument and then `MakeGenericType` plus `GetConstructed`
(`Binding/MemberLookup.gs:1748-1996`). **Evidence.** `metadata.contract-requests`
101,476 on Core against 6,865 decodes: the raw bytes are cached (#5070) but
the symbol is rebuilt 100k times. `TypeSymbol.GetWrappedTypes` was 9.8% of
compiler allocation in the 0.5.199 profile. **Change.** (1) A per-resolver
`ConditionalWeakTable[MemberInfo, DecodedSignature]` holding the final
return/parameter symbols for the receiver-free case (receiver substitution
stays a separate step); (2) intern `ImportedTypeSymbol.GetConstructed` by
`(definition, TypeArgsKey)` per resolver, the way `StructSymbol.Construct`
already does; (3) memoize `SubstituteType` per `(type, substitution identity)`
within a body. The ADR-0193 funnel rules apply: the cache sits behind
`NullabilityImportRule`, not beside it. **Gain.** Estimated 3 to 8% of body
binding and a large share of `GetWrappedTypes` allocation. **Risk.** Low to
medium; identity of interned constructions is observable by the emitter's
symbol-keyed caches, which today miss on structurally equal constructions
(`Emit/MetadataTokenCache.gs:440-537`), so interning can only increase hits.
**Effort.** M. **Dependencies.** None. N-1: ordinary source.

### P6. Build the reference type-name index from metadata, not from `GetTypes()`

**Problem.** `BuildTypeNameIndex` materializes every type in the closure with
`asm.GetTypes()` and `asm.GetForwardedTypes()` and reads `FullName` for each
(`Symbols/ReferenceResolver.gs:1734-1786`). On hello world this is 135 ms of
561; on Core 200 ms; on LanguageServer 158 ms. ADR-0107 measured the same
cost at about 120 ms on Oahu in the language server and persisted it as a
`.lscache`; `gsc` never adopts that index (`src/Compiler/Program.gs` has no
`TryUseMetadataIndex` call; `src/LanguageServer/ProjectState.gs:536-552` is
the only caller). Every image is also read into a `byte[]` up front,
including the whole host TPA list (`:1061-1083, 1437-1450`), and a one-hop
transitive probe loads every referenced assembly name
(`ComputeMissingTransitiveReferences`, `:2060`). **Change.** (1) Build the
name index by walking `MetadataReader.TypeDefinitions` and `ExportedTypes`
of each PE with `System.Reflection.Metadata` (names only, no `RoType`
materialization), and materialize a `Type` lazily on first hit, which the
warm path `TryMaterializeWarmType` (`:1026-1041`) already does; (2) have
`gsc` adopt the content-fingerprinted `ReferenceMetadataIndex` from a cache
directory next to the response file (the SDK can pass the path), so a warm
build skips the walk; (3) memory-map images rather than copying them.
**Gain.** 100 to 200 ms per compile; on a 15-project solution that is 2 to 3
s of critical path, and most of the gap between `gsc` and `csc` on a small
project (section 4.3). **Risk.** Low for (1) and (3); (2) needs the
invalidation rules ADR-0107 wrote down (content fingerprint, ordered
reference set, compiler version). **Effort.** M. **Dependencies.** None.

### P7. Big bet: a handle-backed imported symbol model without `MetadataLoadContext`

**Problem.** Every cost in P5 and P6, the AQN-string identity
(`Emit/TypeIdentityComparer.gs:27-85`; `Symbols/LoadContextSensitiveTypeComparer.gs:57-102`),
the `FullName` switches for primitives (`Symbols/TypeSymbol.gs:220-276`;
`Emit/SignatureEncoder.gs:624-660`), the 4,700 exceptions per compile
(section 4.6), the eager member-array signature resolution
(`Symbols/ClrTypeUtilities.gs:329-360, 1167-1193`), the 121 raw
`GetMethods(` sites and the cross-context rules the emitter needs
(`ReferenceResolver.MapClrTypeToReferences`, `:683-776`) exist because the
compiler models imported metadata as `System.Type` and `MethodInfo` from a
`MetadataLoadContext`. Roslyn's `PEModuleSymbol` reads handles and decodes
signatures lazily into its own symbols; identity is the symbol object.
**Change.** Introduce `MetadataTypeSymbol`/`MetadataMethodSymbol` backed by
`(PEReader, handle)` with lazily decoded members and attributes, make
`ImportedTypeSymbol` an adapter over it, and retire the MLC once the binder
and emitter no longer touch `System.Type` for imported members. The emitter
already writes signatures itself, so the emitter side is a `SignatureEncoder`
input change. **Gain.** The whole metadata import cost model changes: no
image copies, no eager type materialization, no exceptions, reference-equal
identity. Estimated at a 10 to 20% reduction of Core wall time and a larger
share of the small-project time; this is the single biggest architectural
lever after binding itself, and it is what makes a shared compiler process
(P9) cheap because a `PEReader`-backed module is reusable across
compilations. **Risk.** High; it touches `MemberLookup` (9k lines),
`ClrOverloadResolution` (9.6k), the nullability funnel and the emitter's
`ImportedMemberRefFactory`. It goes through an ADR, which the maintainer
approved scoping now as a separate work item (section 10, decision 4), and
lands behind an adapter with the MLC path as the oracle. **Effort.** XL (a release or more).
**Dependencies.** P5 (the caches become the adapter's first layer) and S2
(the nullability funnel is the only sanctioned entry).

### P8. Ship ReadyToRun compiler binaries and set tiering defaults

**Problem.** `PublishReadyToRun=false` is explicit in the SDK packaging
(`src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj:133, 155, 182`), and
`build/sdk-publish.targets:21` lists `PublishReadyToRun` among the publish
settings that make the normal build output ineligible for reuse by the #5103
staging path (the payload then publishes through the isolated graph; it is a
packaging-cost condition, not a build failure). The maintainer's decision
(section 10, decision 2) is that R2R works for the compiler payload; the
incompatibility that was found earlier was with NativeAOT. No `TieredPGO`,
`TieredCompilation` or GC setting is in `src/Compiler/Compiler.gsproj` or the
runtimeconfig. **Evidence.**
`DOTNET_TieredPGO=0` cut Core from 26.7 s to 18.4 s (-31%) and
`TieredCompilation=0` to 17.1 s (-36%) with no code change (section 4.4,
re-measured in 4.5); JIT accounts for about 5 s of the default run (section
4.6); the maintainer measured R2R at -37% on the Oahu build and -8.5% on the
compiler graph (#2189, October 21). The two effects overlap: both reduce time
spent in Tier-0 and instrumented code. **Change.** Two PRs. (1) Set
`<TieredPGO>false</TieredPGO>` in `Compiler.gsproj` (and `Gsgen.Cli`,
`Gsfmt.Cli`), which lands in `gsc.runtimeconfig.json`; measure Core, Oahu
and hello world. (2) Enable `PublishReadyToRun` for the three published
tool payloads, either by extending the `sdk-publish.targets:21` reuse
condition so an R2R publish of the normal build output still qualifies, or
by accepting the isolated publish graph for those three projects; measure the
same three inputs with and without `TieredPGO`. Keep `TieredCompilation` on
(hello world doubles without it). **Gain.** Measured -28% on Core for (1)
alone (section 4.5); (2) measured -30% on hello world and -10% on Core alone,
and -36% on Core together with (1) (section 4.8).
**Risk.** Low; output bytes do not depend on the JIT mode (section 4.5 checks
the hashes). The R2R payload is larger (crossgen output) and the SDK package
grows; the stage-2 comparison compares the IL assemblies the repository
builds, not the published R2R images, so it is unaffected (confirm on the
first pin move that carries R2R). **Effort.** S for (1), M for (2). **Bootstrap.** The
compiler that builds the repository is the pinned release, so the repository
build speeds up only after the pin moves to a release carrying the setting.

### P9. Let metadata and symbols survive compiler-worker requests

**Problem.** The worker (#5048) keeps only JIT state and host TPA bytes
between requests; `ReferenceResolver.Dispose` clears about 21 process-wide
caches at the end of every request (`Symbols/ReferenceResolver.gs:243-295`),
each request builds a new `MetadataLoadContext` and re-reads every user
reference (`:1061-1083, 1105-1119`), and the worker is off by default
(`src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Sdk.props:7`), serial, retires
after 16 requests or 256 MiB retained (`src/Compiler/WorkerProtocol.gs:14-17`),
retires on any `/gsanalyzer` (`src/Compiler/Program.gs:303-307`, which
includes Core's own build), and recomputes a SHA-256 of the whole tool
directory per request (`src/Sdk/Gsharp.NET.Sdk/WorkerProcessClient.gs:54`).
Roslyn's server caches `MetadataReference` by path and timestamp and runs
requests concurrently. **Change.** (1) Move the 15 `TypeSymbol`-keyed and 5
`MemberCache` process statics onto the resolver instance (this also fixes
the language server, which never disposes its resolver,
`src/LanguageServer/ProjectState.gs:126, 447, 469`); (2) split the resolver
into a consumer-independent part and a compilation-owned part, and cache only
the first across requests. Consumer-independent: the loaded images, the
`MetadataLoadContext`, and the type-name, namespace and arity indexes, keyed
by the ordered reference set with path, size, mtime and content fingerprint.
Compilation-owned and never shared: everything that depends on the consumer
assembly's identity or access rights, in particular `semanticAggregateCache`
(keyed by `Type` on the assumption of one consumer per resolver,
`Symbols/ReferenceResolver.gs:57-79, 131-133`) and the aggregates
`ImportedTypeSymbol.BuildSemanticAggregate` builds with the consumer's
internal-access grant (`Symbols/ImportedTypeSymbol.gs:455-461`); a friend
project must never see an aggregate a non-friend project filled. The same
partition applies to B5; (3) keep the content-sensitive tool-identity check
(`WorkerProcessClient.TryRun` recomputes it before every dispatch and
restarts on a mismatch, `src/Sdk/Gsharp.NET.Sdk/WorkerProcessClient.gs:54-66`;
`test/Sdk.Tests/CompilerWorkerTests.gs:833` `ChangedToolPayloadStartsANewWorker`
pins the contract) but make it cheap: cache the hash per file by (path,
size, mtime) and re-hash only files whose stat changed; (4) raise the request
cap once (1) and (2) make retained memory a function of the live reference
set. **Gain.** The maintainer's probe measured 3.3x to 3.7x on late calls
with only JIT warm; metadata reuse makes a warm request cheaper still and
makes turning the worker on by default defensible. **Risk.** Medium;
cross-compilation symbol identity must stay per-resolver (GSA0003 convention;
ADR-0203 §3), and the consumer-dependent partition in (2) is the correctness
line. **Effort.** M for (1) and (3), M for (2). **Dependencies.** (2) is much
simpler after P7; (1) and (3) stand alone.

### P10. Analyzer host: one load context per analyzer path per process

**Problem.** `GSharpAnalyzerHost` creates a new collectible
`AssemblyLoadContext` per analyzer path on every compile and never unloads it
(`src/Core/CodeAnalysis/Analyzers/GSharpAnalyzerHost.gs:34, 117`), discovers
analyzers by `GetExportedTypes` plus `Activator.CreateInstance` (`:121-131`),
and the worker retires when analyzers are present. The internal analyzers
over Core take 2.4 s (9% of the Core compile, section 4.2); analyzer code
runs cold-JIT in every process. **Change.** Cache the load context and the
discovered analyzer instances per (path, size, mtime) in the worker; run
analyzers in the same process as the compile they analyze (already the case)
but allow the worker to continue after them once the load context is proven
isolated (an unload-and-check step on retirement is enough). **Gain.** The
analyzer phase becomes warm on the second project in a build; today every
project with analyzers forces a fresh process. **Risk.** Medium (analyzer
authors can leak threads; the retirement check must stay). **Effort.** M.
**Dependencies.** P9.

### P11. Lowering and emit allocation (the performance face of S4 and S6)

**Problem.** Emit is 6% and lowering under 2% of Core wall, so neither is a
throughput target, but together they allocate 1.1 GiB per Core compile
(section 4.2) and they are where the parallel-emit plan (#5042) runs. The
per-body emit session allocates 17 dictionaries and a list
(`Emit/ReflectionMetadataEmitter.gs:4189-4228`); the planner runs about 15
collector walkers per body (`Emit/MethodBodyPlanner.gs:198-526`);
`MaxStackTracker.ComputeMaxStack` copies the IL (`Emit/MaxStackTracker.gs:80`);
303 `BlobBuilder()` sites, no pooling; `UserTokenResolver.BuildMethodSpec`
and `TryCreateMemberReferenceForConstructedSymbolicContainer` add new rows
per call (`Emit/UserTokenResolver.gs:428-435`;
`Emit/ImportedMemberRefFactory.gs:765-885`). **Change.** Pool the emit
session and planner collectors; compute max-stack during emission (SRM's
`InstructionEncoder` does not, but the emitter knows every push/pop it
emits); cache `MethodSpec` and constructed-container `MemberRef` rows by
`(open handle, TypeArgsKey)`. **Gain.** Allocation only; estimated 0.3 to
0.6 GiB of the 1.1 GiB. **Risk.** Low. **Effort.** M. **Bootstrap.** Emit
change. Pooling and max-stack computation are representation-preserving and
must keep output byte-identical; row deduplication changes the metadata
tables on purpose, so its acceptance is ILVerify, the conformance suite, an
expected-IL or expected-table test that fails without the change (the
ADR-0154 witness), and repeat-run determinism.

### P13. Code generation: `for ... in` over a generic collection of a same-compilation element type boxes the enumerator

**Problem.** The for-in lowering has two paths. For a closed CLR collection
type, `Lowerer.TryBuildGetEnumeratorCall` calls
`MemberLookup.ResolveGetEnumerator`, which prefers the collection's own
public `GetEnumerator()` (a struct enumerator for `ImmutableArray[T]` and
`List[T]`) over the interface (`Lowering/Lowerer.gs:1424-1437`;
`Binding/MemberLookup.gs:802`). But when the collection is an imported generic
whose type arguments are symbolic (a same-compilation type or an in-scope type
parameter), `TryBuildSymbolicOpenGetEnumeratorCall` runs first and routes the
loop through `IEnumerable<T>.GetEnumerator()` over a symbolic `IEnumerator<T>`
so the element type survives emit; its comment accepts the allocation as the
price of avoiding a nested struct enumerator in symbolic emit
(`Lowering/Lowerer.gs:1401, 1485-1576`; the comment at `:1517-1523`). In the
compiler, almost every collection is a collection of the compiler's own types
(`ImmutableArray[BoundExpression]`, `List[FunctionSymbol]`), so almost every
loop takes the symbolic path. **Evidence.** Decompiled
`BoundTreeWalker.VisitList` (`Binding/BoundTreeWalker.gs:828-836`) and
`RendezvousBatchAnalyzer.Run` (`Binding/RendezvousBatchAnalyzer.gs:171-173`)
from the built `GSharp.Core.dll` show
`((IEnumerable<T>)items).GetEnumerator()` for `ImmutableArray[BoundExpression]`
and `List[(string, TextLocation)]`; `CastHelpers.Box` is 12.4% of main-thread
samples with loop bodies as its callers (section 4.7); `src/Core` has 2,991
`for ... in` loops, of which the share over symbolic element types is not
counted here. **Change.** Teach the symbolic path to use the struct
enumerator: encode the nested `Enumerator` of a known collection
(`ImmutableArray<T>.Enumerator`, `List<T>.Enumerator`,
`Dictionary<K,V>.Enumerator`) as a symbolic `TypeSpec` over the element
symbol, the same way the symbolic `MemberRef` helper already re-encodes
`IEnumerable<T>.GetEnumerator()`, and emit `MoveNext`/`Current` as direct
calls on it. Start with the collections the compiler itself uses; keep the
interface path for `sequence[T]`, for user types, and for any collection
whose public `GetEnumerator()` and `IEnumerable<T>` implementation differ in
element type or values (the compatibility tests must include such a type,
since switching methods is not automatically semantics-preserving).
Disposal follows the C# rule for struct enumerators, and the #5037
nested-enumerator cleanup must keep working. ADR-0031 already admits the
pattern-based shape as a discriminant, so no ADR change is needed. **Gain.**
One allocation and one interface dispatch per loop over a compiler-typed
collection, in the compiler and in user programs with the same shape;
estimated several percent of body-binding allocation, measurable through the
`CastHelpers.Box` share. **Risk.** Medium (codegen in symbolic emit; ILVerify,
the conformance suite and the compatibility tests above are the gates; the
ADR-0154 witness is an expected-IL test that fails on the pre-change
lowering). **Effort.** M. **Bootstrap.** The compiler's own loops get the
benefit only after the pin moves to a release that carries the change;
measure with a self-rebuilt compiler as #5107 did.

### P12. Small, measured quick wins

| Item | Evidence | Change | Expected |
| --- | --- | --- | --- |
| `ContainsSyntheticBodySideEffects` walks every body in `gsc` | `Binding/Binder.gs:8460-8461`; profile frame at 0.18% inclusive | Check `cache != nil` first | about 50 ms on Core |
| Exceptions as control flow in reflection probes | 4,737 first-chance exceptions per Core compile (section 4.6) | Test `type is TypeBuilderInstantiation`/`IsGenericTypeDefinition` before calling; use `MetadataLoadContext`-safe probes | under 0.5 s; removes noise from every profile |
| `SyntaxFacts.Get*OperatorKinds` call `Enum.GetValues` per call | `Syntax/SyntaxFacts.gs:394, 405` | Static arrays | small |
| `TextLocation` recomputes line lookups | `Text/TextLocation.gs:39-51` | Compute line once per diagnostic | small |
| Identifier substring before interning | `Syntax/Lexer.gs:1572-1581` | Span-keyed intern lookup (`AlternateLookup<ReadOnlySpan<char>>` in .NET 9+) | parse allocation (561 MiB on Core) |
| Whitespace and comment tokens allocated then dropped | `Syntax/Parser.gs:126-129`; `Lexer.gs:466-557` | Lexer skips trivia unless a consumer (formatter, documentation) asked for it; comments keep `Text` only | parse allocation |
| `GetDeclaredInterfaces`/`Enums`/`Delegates` rebuilt per call | `Binding/BoundScope.gs:1484-1493` | Memoize | small |
| `BoundProgramOrder.Functions` re-sorts 11 times | `Binding/BoundProgramOrder.gs:23-29` | Sort once in `BoundProgram` | small |
| `Conversion.ContainsPlatformType` allocates a `Stack` and a `HashSet` per call | `Binding/Conversion.gs:4308-4327`; 4.9% of main-thread samples in `Stack.PushWithResize` (section 4.7) | Cache a "contains platform type" bit per type symbol, or walk without allocating | up to a few percent of body binding |
| `ImportedTypeSymbol.Get` takes a lock per lookup in a single-threaded compile | `Symbols/ImportedTypeSymbol.gs:252`; `Monitor.Enter_Slowpath` 1.9% (section 4.7) | Lock-free read path (publish-first dictionary), lock only on insert | about 1 to 2% |
| `SyntaxTree.BuildParentIndex` hashes every node by reference for the analyzer host | `Syntax/SyntaxTree.gs:103-115`; 1.6% (section 4.7) | Store the parent on the node at parse time (one field) | about 1.5% plus a simpler `Parent` |

Each row is an S-sized PR with byte-identical output as the witness and the
phase JSON before and after as the measurement.

## 8. What transfers from Roslyn and what does not

| Roslyn mechanism | What it buys Roslyn | G# today | Transfer? |
| --- | --- | --- | --- |
| Green/red syntax trees (position-free green nodes, lazily materialized red wrappers with parents) | Incremental reparse reusing unchanged subtrees; cheap `Parent`; width-only spans | One layer, no parent, lazily built parent dictionary, boxed cached span | **Not now.** The batch compiler never reparses, and parse is 4% of Core. The win is for the language server (ADR-0105). Do S8 first (generated children, source-order spans); revisit red/green when incremental parse is scheduled. |
| `SourceText` with `TextChange`/`WithChanges`, `SlidingTextWindow` lexer | Incremental text and allocation-free lexing | One `string`, substring per token, no change API | **Partly.** Span-based identifier lookup and a `StringTable` (interning across files, not per lexer) transfer and are small. Incremental text is a language-server item. |
| Lazy symbol completion (`ForceComplete`, per-part completion of members, lazily bound attributes and constraints) | Only what is queried is bound; natural parallel declaration binding | Everything eager; deferred queues drained at fixed points; no syntax-to-binder map | **Partly, later.** Full laziness is a redesign of `DeclarationBinder`. What transfers now: a syntax-to-scope map (so the language server and body workers can find a binder without rebuilding the chain) and making declaration binding per-tree parallel at the shell stage, which the deferred queues already make possible. |
| Binder chain (immutable `Binder` objects per scope, created on demand, cached per syntax node in `BinderFactory`) | Cheap per-body binding; shared, immutable lookup | `BoundScope` chain with mutable builders; `Binder` graph rebuilt per body | **Yes.** This is S1/P1. Roslyn's split between the immutable chain and the per-body `LocalBinder` is the model. |
| `PEModuleSymbol` metadata import over `System.Reflection.Metadata` handles (no `System.Type`, lazy per-type member loading, by-name member dictionaries, attribute blobs decoded on demand) | Cheap reference import, no eager materialization, reference-equal symbols per handle | `MetadataLoadContext`, eager `GetTypes()` for the name index, member arrays plus eager signature resolution, `CustomAttributeData` decoding, AQN-string identity | **Yes, in stages.** Stage 1 (P5): cache decoded signatures per `MemberInfo` and intern imported constructions. Stage 2 (P6): build the type-name index from `MetadataReader` type-definition names, not `GetTypes()`. Stage 3 (P7, a big bet): replace `System.Type` in `ImportedTypeSymbol` with a handle-backed symbol and drop the MLC. The emitter already encodes signatures itself, so stage 3 is mostly binder-side. |
| Per-tree parallel binding and per-method parallel lowering/emit (`Compilation.GetDiagnostics` binds method bodies in parallel; `MethodCompiler` compiles in parallel) | Multi-core compile | Bounded workers exist (#5041) but default to 1 and admit only call-free bodies | **Yes, but gated on S1.** Roslyn can bind bodies in parallel because the shared state is immutable symbols plus a thread-safe `DiagnosticBag`. G#'s shared mutable synthesis state (`AnonymousTypeCache`, `SynthesizedRefDelegateCache`, `StructuralAdapterRegistry`, the constraint queue; `BoundScope.gs:1540-1710`) and bind-order-dependent names (`<>RefFunc{counter}`, `SynthesizedRefDelegateCache.gs:52`) must become stable-keyed and lock-free (or deferred to a serial merge) first. |
| Pooled objects (`ArrayBuilder<T>` pools, `PooledHashSet`, `PooledStringBuilder`, `BlobBuilder` reuse) | Low gen0 churn | No pools; 303 `BlobBuilder()` sites; `HashSet` per branch in definite assignment; new `Dictionary` per scope frame | **Yes, selectively.** Pool the per-body emit session (17 dictionaries, `ReflectionMetadataEmitter.gs:4189-4228`), the planner collectors, and definite-assignment sets. Measure gen0 count before and after (section 4 gives today's count). |
| Interned strings (`StringTable`) and `SpecialType` enum instead of name switches | No per-lookup string building | Keys built per lookup (`BoundScope.gs:561, 566, 615, 633, 713, 1847, 2614`; `TupleTypeSymbol.gs:168-189`; `FunctionTypeSymbol.gs:164-186`); primitives matched by `FullName` switch (`TypeSymbol.gs:220-276`; `SignatureEncoder.gs:624-660`) | **Yes.** A `SpecialType`-like tag on `ImportedTypeSymbol` and struct keys for the synthesis caches are S-sized. |
| Compiler server (`VBCSCompiler`: well-known pipe, mutex, 10-minute keep-alive, `MetadataReference` cache keyed by path and timestamp, analyzer loader reuse, concurrent requests) | Amortized JIT and metadata across the whole build and across builds | Worker exists; off by default; serial; 60 s idle; 16-request cap; discards all metadata per request; retires on analyzers | **Yes, incrementally.** Turning it on needs P9 (metadata survives requests) and P10 (analyzer load contexts reused or isolated), not a new transport. |
| ReadyToRun compiler binaries | Startup | `PublishReadyToRun=false` explicit (`src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj:133, 155, 182`) | **Yes.** The maintainer measured -37% on Oahu and -8.5% on the compiler graph. P8. |
| `Compilation` is immutable; semantic queries are pure functions with caches | Safe sharing, incremental language server | `Compilation` is mostly immutable; `BoundProgram` lazily published; caches are process-wide statics cleared by `ReferenceResolver.Dispose` | **Partly.** Move the 15 process-wide `TypeSymbol`-keyed statics and the 5 `MemberCache` statics onto the resolver (P9); this also fixes the language server, which never disposes its resolver (`src/LanguageServer/ProjectState.gs:126, 447, 469`). |
| TypeScript 7 private checker worlds | Multi-core checking | Rejected by ADR-0203 | **No.** Keep canonical symbols. |

## 9. Roadmap

Each item is sized for one coding agent and one PR (an "L" item is a short
series of PRs with one owner). "Parallel" means the items touch different
files and can run in separate worktrees at the same time; "after" names the
PR that must merge first. Two kinds of evidence apply, and they are not the
same thing. (a) The ADR-0154 witness: every new or changed behavioral test
fails on the pre-change code or under a product mutant and passes with the
change; a byte comparison alone is not that witness. (b) The regression
check: for a representation-preserving change (caches, indexes, pooling,
scope and binder restructuring, JIT settings) the implementation, reference,
PDB and XML output and the diagnostics on Core, Core.Tests and the pinned
Oahu inputs stay byte-identical; for a change that alters output on purpose
(Q8's enumeration IL, M8's metadata-row deduplication) the check is instead
ILVerify, the conformance suite, public-contract and expected-IL or
expected-table tests, and repeat-run determinism. The phase JSON before and
after is the performance evidence in both cases. "Identical outputs" in the
tables below means (b) for a representation-preserving item. None may use a
language feature newer than the pin (N-1). Items marked **bootstrap** change code generation or the
compiler's runtime configuration: their effect on the compiler's own speed
appears only after the next pin move, and their measurement must use a
compiler rebuilt by itself where the maintainer's #5107 caveat applies.

### Quick wins (weeks, low risk)

| # | Item | Section | Effort | Run with | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Q1 | `TieredPGO=false` in the three published tool projects | P8 (1) | S | anything | Core median wall down 25% or more over five interleaved pairs (this study measured -27.8%); hello-world not slower; hashes identical. **Bootstrap** (repository build benefits after the pin moves) |
| Q8 | Symbolic for-in path uses the known struct enumerators (`ImmutableArray<T>`, `List<T>`, `Dictionary<K,V>`) | P13 | M | Q2 to Q6 | Intentional IL change: expected-IL test red on the pre-change lowering (witness); ILVerify and conformance green; compatibility tests for a type whose public and interface enumerators differ; decompiled `VisitList` shows no interface cast; `CastHelpers.Box` share down in a self-rebuilt compiler. **Bootstrap** |
| Q2 | `ContainsSyntheticBodySideEffects` behind `cache != nil`; `Enum.GetValues` statics; `TextLocation` line caching; `BoundProgramOrder` sort once; memoize `GetDeclared*` | P12, S9 | S | Q1, Q3, Q4 | Identical outputs; phase JSON shows the walks gone |
| Q3 | Imported-extension holder index owned by the compilation | P2 | S to M | Q1, Q2, Q4 | `references.extension-holders` count 1 per compile on Core (was 812); identical outputs; Oahu.Core direct-compile time |
| Q4 | Reflection probes stop throwing: guard `TypeBuilderInstantiation` and MLC cases before the call | P12 | S | Q1, Q2, Q3 | `dotnet-counters` exception total under 100 on Core; identical outputs |
| Q5 | `gsc` adopts the ADR-0107 content-fingerprinted type-name index from a cache directory the SDK passes; name index built from `MetadataReader` names | P6 | M | Q1 to Q4 | Hello-world `declarations` phase under 150 ms warm; identical outputs; cache invalidation tests for changed reference bytes and order |
| Q6 | Decoded imported signature cache; intern `ImportedTypeSymbol.GetConstructed`; memoize `SubstituteType` | P5 | M | Q1 to Q5 | `metadata.contract-requests` unchanged and a new `metadata.signature-cache-hits` counter near it; Core allocation down; identical outputs |
| Q9 | `build/compiler-bench.py`: the Core, LanguageServer and hello-world cells of section 11 on demand (decision 7) | section 11 | S | anything | Reproduces the section 4 tables on this host within run-to-run variation |
| Q7 | ReadyToRun for the published `gsc`, `gsgen`, `gsfmt` payloads (decision 2: R2R is viable, probe in section 4.8; extend or bypass the `sdk-publish.targets:21` reuse condition; keep `packages.lock.json` stable) | P8 (2) | M | Q1 (measure both settings together) | Oahu whole-build and hello-world medians down (probe: hello 0.56 s to 0.39 s, Core -10% alone and -36% with Q1); stage-2 comparison still byte-identical for `GSharp.Core.dll` and `gsc.dll` (R2R code is in the published payload, not in the IL compared by stage 2; confirm). **Bootstrap** |

### Medium items (one to two months, medium risk)

| # | Item | Section | Effort | Run with | Acceptance |
| --- | --- | --- | --- | --- | --- |
| M1a | Per-statement effect summaries; if-join from bound-under frames | S7, P3 | M | M2, M4 | Narrowing conformance suite green; Core body-binding phase down; identical outputs |
| M1b | Narrowing as a flow-state computation consumed by binding through a query (decision 3): ADR first, then the pass | S7 | L (ADR + 2 PRs) | after M1a | ADR accepted; the loop re-bind, the if-join interpreter and `AssignedRootsCollector` removed; conformance green with the ADR's listed corner-case changes as new tests (ADR-0154 witness) |
| M2 | `BodyFacts` record; single lambda lowering; one `SideEffectAnalyzer` | S4 | M | M1, M4 | Walk count per body (add a debug counter) down by 8 or more; identical outputs. **Bootstrap** for the lambda change |
| M3 | `LoweringPipeline`: one ordered pass over bodies, facts-gated rewriters, entry-point aliasing handled once | S6 | M | after M2 | Identical outputs; lowering allocation down |
| M4 | ADR-0193 Phase 3 as one atomic PR: query API, GSA0008 and the full consumer migration (about 80 files, reviewed in ownership slices); `NullabilityAnnotatedTypeSymbol` interning may land before it as its own PR | S2 | L (one PR) | M1, M2, Q6 | GSA0008 reports zero sites in Core with no suppressions or path filters; identical outputs |
| M5 | Resolver-owned caches (move the 20 process statics); tool identity hashed per file by (path, size, mtime) with content re-hash on change; language-server resolver disposal | P9 (1), (3) | M | M1 to M4 | Language-server soak (`build/lsp-soak.py`) memory flat; worker request cap raised with retained memory flat; `CompilerWorkerTests.ChangedToolPayloadStartsANewWorker` stays green |
| M6 | Conversion and signature-equality owners (`Conversion` owns classification; one `SignatureEquality`; one `EnumerateSelfAndInterfaces`) | S3 | S x 3 to 5 | M1 to M5 | Identical outputs; duplicated functions deleted |
| M7 | Generated `GetChildren`/`ChildCount`/`GetChild(i)` in source order; `Span` from first and last child | S8 | M | M1 to M6 | `GetChildPropertiesInEnumerationOrder` oracle test; identical outputs; parse allocation down |
| M8 | Emit and planner pooling; max-stack during emission; cached `MethodSpec`/constructed `MemberRef` rows | P11 | M | M1 to M7 | Pooling and max-stack: identical outputs. Row deduplication (an intentional table change): ILVerify, conformance, an expected-table test red on the pre-change emitter, repeat-run determinism; emit allocation down. **Bootstrap** |
| M9 | Analyzer load-context reuse in the worker | P10 | M | after M5 | Worker survives analyzer requests; `analyzers` phase warm on the second project |
| M10 | Language-server surface (decision 6): a semantic-query API on `Compilation`/`SemanticModel` with the visibility the server needs; `BoundBodyCache`, `IncrementalGlobalScopeReuse` and the submission paths behind it or moved out of `Binder` | section 5, "language-server weight" | L | M1a to M5; binder side after B1 | Core line count for server-only code down; `Binder.gs` carries no submission or body-cache logic; language-server tests green |

### Big bets (a release or more, high risk, each needs an ADR)

| # | Item | Section | Effort | After | Acceptance |
| --- | --- | --- | --- | --- | --- |
| B1 | `BindingServices` / `BodyBinder` split | S1, P1 | L (3 PRs) | M1, M2 | Identical outputs; per-body allocation down; `Binder.gs` constructor gone |
| B2 | Stable synthesized identities; concurrent synthesis caches; widened body-worker eligibility | P4 | L (3 PRs) | B1 | Identical outputs at workers 1, 2, 4, 8 on Core, Core.Tests, Oahu; measured speedup at 4 |
| B3 | One region-aware CFG per body shared by definite-return, definite assignment and liveness | S5 | L | M2 | Dataflow oracle tests green; definite-assignment allocation down |
| B4 | Handle-backed imported symbols; retire `MetadataLoadContext` (decision 4: ADR written now, as a separate work item; Q6 and M4 are its first layer) | P7 | XL | ADR, then Q6, M4 | Adapter lands first with the MLC path as oracle; identical outputs; Core wall and hello-world down |
| B5 | Reuse of the consumer-independent resolver part (images, MLC, name indexes) across worker requests; compilation-owned state (semantic aggregates, internal-access-dependent symbols) never shared; worker on by default (decision 5) | P9 (2), (4) | M after B4 (L before) | M5, B4 | Oahu whole-build with shared compilation faster than without on five pairs; no retained-memory growth over 50 requests; a friend/non-friend project pair compiled in either order produces identical output to standalone compiles |

### Sequencing

```text
Q1, Q7 ─┐
Q2      │ (parallel, week 1-2)     M1a ─► M1b (after the narrowing ADR)
Q3      ├─────────────────────────► M2  ─┐
Q4      │                           M4   ├─► M3 ─► B1 ─► B2, M10 (binder side)
Q5, Q9 ─┘                           M5  ─┘─► M9
Q6 ───────────────────────────────► M4, B4 (B4 ADR written now)
                                    M6, M7, M8, M10 (parallel with M1-M5)
                                    B3 (after M2)      B5 (after M5, B4; flips the worker default)
```

What I would not do yet: a red/green syntax tree (no batch-compile gain until
incremental parse is a goal), a Go- or TypeScript-style checker pool
(ADR-0203 rejected it), or splitting the large files by size alone.

### Expected end state (estimate, not a forecast)

If Q1, Q3, Q5, Q6, Q8, M1, M2 and B1 land as described, Core should compile
in the 11 to 14 s range on this host from today's 27 s (Q1 alone measured
18.8 s), with B2 then dividing
the body phase by the worker count minus coordination. Reaching `csc`'s 9 s
for the compiler product graph needs B4 as well, because the remaining gap
after binding is metadata import and startup, both of which are structural.
These figures combine independent estimates and must be re-measured after
each landing; the maintainer's rule that gains are not additive applies.

## 10. Decisions

The study asked the maintainer seven questions. The decisions, recorded on
2026-10-22, and what each one changes in the roadmap:

1. **Tiering default: evaluate and set it per the measurements.** There was
   no prior analysis and no reason the setting was left at the default. Q1
   (`TieredPGO=false` for the published `gsc`, `gsgen` and `gsfmt`) proceeds
   on the section 4.5 evidence (-27.8% on Core over five interleaved pairs,
   -19% on LanguageServer, byte-identical output, hello world not slower).
   `TieredCompilation` stays on because it doubles the hello-world time when
   off. The next pin move after the release that carries the setting is when
   the repository build itself speeds up.
2. **ReadyToRun: viable.** The incompatibility recorded in the packaging
   targets was found with NativeAOT (the maintainer's October 21 report
   describes 658 and 486 IL-analysis diagnostics under strict NativeAOT
   publish), not with ReadyToRun; R2R works, and the maintainer measured it
   at -37% on the Oahu build and -8.5% on the compiler graph with the 0.5.199
   payload. `build/sdk-publish.targets:21` only excludes an R2R publish from
   the #5103 build-output reuse path; the payload still publishes through
   the isolated graph. Q7 is therefore a packaging and measurement item, not
   a research item: enable `PublishReadyToRun` for the three tool payloads,
   extend the reuse condition if the packaging time matters, and measure
   with and without `TieredPGO`. Section 4.8 records the probe run after the
   decision: R2R alone gives -30% on hello world and -10% on Core, and R2R
   with `TieredPGO=0` gives -36% on Core with byte-identical output. Text
   elsewhere in this document that described R2R as incompatible with staging
   has been corrected to this reading.
3. **Narrowing semantics change: approved.** S7 and P3 are no longer limited
   to "compute the facts once and stop re-walking". The approved direction is
   an ADR that makes narrowing a flow-state computation whose results binding
   consumes through a query, so that the per-statement re-walks, the if-join
   interpreter and the loop re-bind disappear structurally. M1 becomes two
   steps: M1a (per-statement effect summaries, which the final design needs
   anyway and which lands without the ADR) and M1b (the ADR plus the
   flow-state pass). Corner cases where the result changes are a language
   change and go through the ADR's compatibility section.
4. **Metadata model (B4): approved, scoped as an ADR now.** The ADR is a
   separate work item from this PR. Q6 (decoded signature cache, interned
   imported constructions) and M4 (the nullability funnel completion) are
   built as the first layer of that design: the cache lives behind the
   `NullabilityImportRule` funnel and the interned constructions are what the
   handle-backed symbols will replace. B4 no longer waits for B1 and B2 to
   show what binding alone can reach.
5. **Compiler worker default: approved to turn on, after P9.** M5 (resolver-
   owned caches, cheap content-sensitive tool identity) and B5 (reuse of the
   consumer-independent resolver part only) are the prerequisites; B5's
   acceptance row includes the friend/non-friend ordering test from the
   review of this study. The default flips in the PR that lands B5, and the
   SDK property stays as the opt-out.
6. **Language-server weight in Core: simplify; less code in Core.** The
   language-server-specific APIs in Core exist because member access is
   internal or private, so the server reached in. The work item is to design
   the abstraction and the visibility the server needs to operate (a
   semantic-query surface on `Compilation` and `SemanticModel`, with
   `BoundBodyCache`, `IncrementalGlobalScopeReuse` and the submission paths
   behind it or outside Core), then move the code. This is a new medium item,
   M10, that runs with M1 to M5 and depends on B1 for the binder side.
7. **Measurement discipline: approved.** A `build/compiler-bench.py` that
   runs the Core, LanguageServer and hello-world cells from section 11 on
   demand (not in CI) is a quick-win item, Q9, so every roadmap PR reports the
   same table.

Roadmap changes that follow: Q7 moves up to run with Q1 (R2R is viable);
Q9 is added; M1 is split into M1a and M1b with M1b gated on the narrowing
ADR; M10 is added; B4's ADR is written now and Q6 and M4 are its first layer;
B5 flips the worker default. The tables in section 9 carry these rows.

## 11. Reproduction

Build first with `dotnet build GSharp.slnx --configuration Release -graph`
from the repository root. Work roots must be off `/tmp` (`CLAUDE.md`).

The response file MSBuild writes for Core lists its sources relative to the
project directory and the SDK task launches `gsc` from there
(`src/Sdk/Gsharp.NET.Sdk/BuildTask.gs:337-339, 429-433`); `gsc` does not
rebase them. So every direct replay below runs from `src/Core` with absolute
compiler and response-file paths, after copying the response file to a work
directory and rewriting only its `/out`, `/pdb`, `/refout`, `/doc` and
`/sourcelink` values to point into that directory (`build/selfhost-bench.py`
does this itself and takes `--cwd`).

```sh
REPO=$PWD
GSC=$REPO/out/bin/Release/Compiler/gsc.dll
WORK=~/.cache/compiler-study/work   # holds the rewritten core.rsp

# Core: published pin against the fresh build, interleaved
python3 build/selfhost-bench.py \
  --rsp $REPO/out/obj/Core/Release/GSharp.Core.rsp --cwd $REPO/src/Core \
  --native ~/.nuget/packages/gsharp.net.sdk/0.5.212/tools/compiler/gsc.dll \
  --migrated $GSC \
  --runs 3 --warmup 1 --budget 1.5 --work ~/.cache/compiler-study/bench-core

cd $REPO/src/Core

# Phase JSON for one compile
GSHARP_MEASURE_PHASES=~/.cache/compiler-study/core.json dotnet $GSC @$WORK/core.rsp

# Runtime knobs: same response file, environment variable per run
DOTNET_TieredPGO=0 dotnet $GSC @$WORK/core.rsp

# GC and JIT counters
dotnet-counters collect --counters System.Runtime --format csv \
  --output ~/.cache/compiler-study/core-counters.csv -- dotnet $GSC @$WORK/core.rsp

# Sample profile
dotnet-trace collect --providers Microsoft-DotNETCore-SampleProfiler \
  --output ~/.cache/compiler-study/core.nettrace -- dotnet $GSC @$WORK/core.rsp
dotnet-trace report ~/.cache/compiler-study/core.nettrace topN -n 40 --inclusive
```

The hello-world response files take the `/r:` lines from the Core response
file; the `csc` file replaces `/r:` with `/reference:`, drops the three G#
runtime assemblies, and adds `/noconfig /nostdlib+`.
