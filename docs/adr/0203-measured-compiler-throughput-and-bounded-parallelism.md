# ADR-0203: Measured compiler throughput and bounded parallelism

- **Status**: Proposed
- **Date**: 2026-10-20
- **Phase**: Compiler performance
- **Related**: #2189; ADR-0027 (Roslyn-free compiler), ADR-0107 (metadata
  indexes), ADR-0145 (generator host), ADR-0154 (discriminating tests),
  ADR-0186 and ADR-0193 (nullability), ADR-0198 (self-host verification).

## Context

The goal is to meet or beat C# build times without reducing correctness,
diagnostics, generated functionality, or output quality. Measurements must
distinguish the compiler, the generator host, and the surrounding build.
Parallelizing the parser alone cannot achieve that goal.

This proposal uses two workloads:

1. The functionally synchronized C# and G# branches of `DavidObando/Oahu`.
2. The compiler product graph on `cs2gs/csharp-0.4` and `main`. These branches
   are not semantically identical. This is a large-workload comparison, not
   a controlled language-only experiment.

Only documentation and measurement artifacts are produced by this study.
No compiler implementation, SDK defaults, bootstrap pins, or Oahu sources
are changed. All optimizations below remain proposed.

### Provenance and method

Measurements started on October 19, 2026, Pacific time, October 20 UTC.
The host was Linux x64, Ubuntu 26.04, Intel i7-13800H, 14 physical cores,
20 logical processors, and 61 GiB RAM. Both languages used .NET SDK
10.0.400, MSBuild 18.9.6, and runtime 10.0.11. Roslyn reported
`5.9.0-1.26379.115`, commit `14fbf8d5271c98133561eb55185fdb05b286f578`.

| Input | Fixed commit or version |
| --- | --- |
| Oahu C#, branch `cs2gs/oahu-csharo` | `78a61d51900a4cbff724a23a3a0f4ee44aecd0cc` |
| Oahu G#, branch `main` | `9db7f232b3c7735e1b40e5d0bc97e7bd7d6edfa8` |
| Oahu's committed G# SDK | `0.5.26`, built from `088200b03dc834da6fcd5c616c382f3d52cdaf58` |
| Compiler C#, branch `cs2gs/csharp-0.4` | `6fff986fc938f4d77c77407ba765ca9d2e58048f` |
| Compiler G#, branch `main` | `c7b82dcb50c75ef440211a1628ac5f438adc75bd` |
| Compiler main's committed bootstrap SDK | `0.5.7`, not Oahu's `0.5.26` |
| TypeScript source inspected | `microsoft/TypeScript` at `28534d7609062699a68b1b66e2367f8d95dbf290` |

Each branch was checked out separately on disk. Restore was completed before
timing. Builds ran sequentially, never against each other or against another
measurement. The language order alternated between pairs.

The primary command was:

```sh
dotnet build Oahu.sln -c Release --no-restore -graph -m:4 -nr:false \
  -t:Rebuild -v:minimal '-clp:PerformanceSummary;Summary' -bl:run.binlog
# Substitute Oahu.slnx on the G# branch.
```

`MSBUILDDISABLENODEREUSE=1` was set for both languages. This does not disable
Roslyn's compiler server. The shipping-settings comparison leaves that
server enabled; diagnostic logs confirmed server compilation.

There was one successful untimed full rebuild of each Oahu solution before
five timed pairs. These are warm-filesystem rebuilds with fresh MSBuild
nodes, not cold-disk builds. Restore, tests, publish, AOT, and application
execution are excluded. All 15 projects, including the GUI, CLI, tests, and
diagnostic tool, are compiled. The host is a shared desktop, not a reserved
benchmark runner. Medians and observed ranges are reported; these small
samples do not establish confidence intervals.
Single-file edit builds, cold OS caches, different machines, and Debug
configuration have not been measured in this study.

The inputs are close, not byte-for-byte equivalents. Oahu has 479 committed
C# files / 64,934 lines and 483 G# files / 60,207 lines. G# also has its
runtime references and a separate generator path. The central package files
differ in Nerdbank.GitVersioning: C# uses `3.7.115`; G# uses
`3.11.13-beta`. G# defaults to XML documentation output where C# does not.
The normalized experiment disables XML documentation and C# shared
compilation on both sides without editing either branch.

### Oahu end-to-end results

| Scenario | C# median | G# median | G# / C# |
| --- | ---: | ---: | ---: |
| Complete solution rebuild, shipping settings, five pairs | 6.942 s | 49.788 s | 7.17x |
| Non-shared compilers, XML documentation disabled, three pairs | 20.310 s | 50.180 s | 2.47x |
| No-op build, five pairs | 3.841 s | 3.710 s | 0.97x |

Shipping-settings rebuild samples, in seconds:

```text
C#: 10.387, 6.510, 6.942, 7.229, 5.968
G#: 52.105, 49.272, 49.788, 50.474, 49.251
```

Non-shared, no-documentation rebuild samples:

```text
C#: 22.363, 20.275, 20.310
G#: 50.180, 50.811, 49.298
```

The normal C# server advantage is part of the user experience, not a
benchmark defect to hide. Conversely, the normalized row does not make
all pipeline stages identical: C# still runs its analyzers and generators
inside `Csc`; G# runs its generator projection/translation separately.

No-op samples:

```text
C#: 3.537, 3.841, 3.927, 3.719, 3.898
G#: 3.582, 3.871, 3.623, 3.816, 3.710
```

No-op logs contain no `Csc`, `BuildTask`, or `GsgenTask` execution.
The rebuild gap therefore is not an equivalent fixed MSBuild startup gap.
The first measured C# rebuild is slower than the later samples despite the
initial warmup. It is retained, not silently removed.

For the third pair, the summed task durations were:

| Task | Sum across 15 projects |
| --- | ---: |
| C# `Csc`, including its analyzers and generators | 3.110 s |
| G# `BuildTask`, which launches `gsc` | 52.372 s |
| G# `GsgenTask` | 34.665 s |

These are sums of elapsed task durations, not CPU time or solution wall
time. Parallel tasks overlap. Do not add them to the solution duration or
call their ratio the pure compiler ratio.

Selected third-pair task durations show where the work sits:

| Project | C# `Csc` | G# `gsc` task | G# generator task |
| --- | ---: | ---: | ---: |
| Oahu.Foundation | 0.338 s | 3.058 s | 1.803 s |
| Oahu.Data | 0.158 s | 5.049 s | 2.154 s |
| Oahu.Core | 0.303 s | 6.005 s | 2.090 s |
| Oahu.Cli.App | 0.234 s | 3.318 s | 1.838 s |
| Oahu.Cli.Tui | 0.333 s | 4.424 s | 2.268 s |
| Oahu.Cli | 0.227 s | 3.640 s | 2.064 s |
| Oahu.Cli.Tests | 0.172 s | 5.583 s | 2.167 s |
| Oahu.UI | 0.255 s | 2.674 s | 7.159 s |

Using those task durations and the project-reference DAG, the longest
compiler-plus-generator path is 45.460 seconds:
Foundation -> Data -> Core -> Cli.App -> Cli.Tui -> Cli -> Cli.Tests.
This is a fixed-task-duration scheduling model, not another measurement.
It excludes other targets and assumes durations do not change with
contention. It explains why adding MSBuild nodes alone has limited room
against the observed 49.788-second build.

In that model, making `gsc` free still leaves a 15.794-second generator
path through Foundation -> Data -> Core -> UI -> App. Making `gsgen` free
still leaves a 31.077-second compiler path. Neither component alone can
reach the 6.942-second shipping C# baseline.

The generator manifests contain 36 generated files for Oahu.UI and two for
Oahu.App; the other 13 are empty. This is **not** permission to skip those
13 generator invocations. They still resolve real framework generators,
which may report diagnostics or produce output after an input change.

### Standalone compiler comparison

Two representative projects were replayed directly, without MSBuild.
Each replay launches a fresh compiler process. The reference closure,
optimization, portable PDB, reference-assembly output, and source inputs
come from the successful builds. C# analyzer arguments and both compilers'
XML-documentation output are removed for this diagnostic experiment.
Neither selected project needs generator-produced source to compile.
Both compiler commands complete successfully.

| Project, five alternating pairs | C# median | G# median | G# / C# | Median C# / G# peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Oahu.Core | 0.970 s | 5.869 s | 6.05x | 205 / 333 MiB |
| Oahu.Cli.Tui | 0.847 s | 4.242 s | 5.01x | 181 / 324 MiB |

Median process CPU times were 3.03 / 5.91 seconds for Core and
3.43 / 4.25 seconds for TUI, C# / G#. Thus G# uses approximately one
core during these cold compilations, while C# accumulates appreciably more
CPU time than elapsed time. That includes runtime activity; it does not
attribute every C# thread to semantic checking.

These measurements establish an actual compiler gap, independent of the
extra `gsgen` process. They are not the shipping-settings build comparison,
because analyzers and documentation have been excluded here.

### Large compiler workload

The comparison builds `src/Compiler/Compiler.csproj` or
`src/Compiler/Compiler.gsproj` and their product dependencies: Core,
InternalAnalyzers, the channel runtime, and the value runtime. It does not
run tests or build the repository's unrelated tools and extensions.
Restore uses the committed lock files.

| Product-graph source inventory | C# branch | G# main |
| --- | ---: | ---: |
| Source files | 755 | 755 |
| Lines, including comments and blank lines | 351,696 | 339,016 |
| Source bytes | 15,893,101 | 16,047,344 |
| Core files | 695 | 698 |
| Core lines | 341,434 | 329,718 |

After normalizing only `.cs` versus `.gs` suffixes, 751 paths are shared,
four were added, and four were removed. Syntax and formatting changes
account for some size differences. These counts do not establish semantic
equivalence: main includes real binding/lowering changes, and its analyzer
set differs. The bootstrap version also differs from the Oahu experiment.
Do not combine the two ratios into one language-performance number.

The first full pair is an excluded warmup. A 10-second trace was attached
only to the first G# warmup; its elapsed time is not a baseline sample.
The following three pairs use the same command, with no attached profiler.

| Compiler product graph, three measured pairs | C# | G# |
| --- | ---: | ---: |
| Median rebuild | 9.392 s | 293.321 s |
| Observed range | 9.222-10.421 s | 291.989-294.946 s |
| G# / C# median ratio | | **31.23x** |

```text
C#: 10.421, 9.222, 9.392
G#: 291.989, 294.946, 293.321
```

The fourth pair, which is also the median pair by elapsed time on each
side, has this task breakdown:

| Project | C# `Csc` | G# `gsc` task | G# generator task |
| --- | ---: | ---: | ---: |
| InternalAnalyzers | 0.108 s | 1.661 s | 1.457 s |
| Core | 6.887 s | 261.803 s | 23.303 s |
| Compiler | 0.066 s | 1.722 s | 1.293 s |
| Gsharp.Runtime.Channels | 0.197 s | 2.635 s | 1.870 s |
| Gsharp.Runtime.Values | 0.090 s | 1.466 s | 1.326 s |

Core's compiler and generator tasks alone total 285.106 seconds. This
workload is dominated by one large compilation, unlike the longer
multi-project dependency chain in Oahu. Increasing project parallelism
cannot split that Core compilation.

**The 31.23x ratio measures the committed main build using SDK 0.5.7.**
It is not a measurement of SDK 0.5.26 compiling this large workload,
nor of running the newly built compiler on itself again. The compiler
produced by the build is the output, not the compiler executing that build.

### Phase probes and experiments without compiler changes

A separate C# measurement host calls the published G# assemblies. It loads
the same sources and references, then forces `GlobalScope`, `BoundProgram`,
and `Emit` in order. Emit uses memory streams and reuses the already-bound
program. Its final bucket includes lowering, both PE passes, PDB, and XML
documentation, not just IL instruction emission.

The first iteration of each fresh host was:

| Phase | Oahu.Core, 34 files | Oahu.Cli.Tui, 54 files |
| --- | ---: | ---: |
| Read and parse sources | 0.134 s | 0.141 s |
| Construct reference resolver | 0.078 s | 0.074 s |
| Global/declaration binding | 1.098 s | 1.123 s |
| Body binding and its whole-program analyses | 3.876 s | 2.133 s |
| Lowering and emit | 0.718 s | 0.572 s |
| Sum of measured buckets | 5.905 s | 4.044 s |

Reference enumeration is lazy. The small resolver-construction number does
not imply that metadata import is cheap: much of it is charged to binding.
These API timings include JIT work on first use. They do not include
process launch and are not substituted for the direct CLI measurements.

**Warm-process experiment.** The host also invokes the unmodified
`GSharp.Compiler.Program.Main` ten times, sequentially, with the original
response file. Every invocation emits identical implementation DLL,
reference DLL, PDB, and XML bytes to the preceding invocation.

| Project | First call | Median of calls 6-10 | First / late |
| --- | ---: | ---: | ---: |
| Oahu.Core | 5.789 s | 1.734 s | 3.34x |
| Oahu.Cli.Tui | 4.181 s | 1.121 s | 3.73x |

This measures an opportunity to amortize runtime/JIT and process-local
setup. It is not a compiler-server implementation or an end-to-end speedup.
It reuses one input repeatedly, not arbitrary projects. Working set rose
from about 337 to 1,864 MiB for Core and 321 to 1,722 MiB for TUI.
Working set alone does not prove a leak, so a separate six-request TUI
probe forced full collections and waited for finalizers between requests.
The managed heap still retained approximately 176, 320, 464, 607, 751,
and 895 MiB. Output hashes remained equal. This establishes repeatable
managed-memory retention, about 144 MiB per additional request in this
probe. The retaining roots have not been identified.

Consequently, the warm-process speedup is **not production-ready**.
Resolve retention or establish safe bounded worker recycling before
enabling reuse. Do not describe the late-call latency as a free SDK switch.

**Parse-only experiment.** Existing `SyntaxTree.Load` calls were scheduled
over separate files using one, two, four, or eight workers. Tree dumps and
parse diagnostics agreed across worker counts.

| Project | One worker, first call | Four workers, first call | One worker, later median | Four workers, later median |
| --- | ---: | ---: | ---: | ---: |
| Oahu.Core | 134 ms | 76 ms | 43 ms | 27 ms |
| Oahu.Cli.Tui | 142 ms | 77 ms | 50 ms | 24 ms |

Each later median covers five iterations after the first. The savings are
real but small in absolute terms: roughly 58-65 ms on a first parse.
Eight workers did not consistently improve the warm TUI result.
This is a phase microbenchmark, not a modified end-to-end compiler.

### Profile evidence

Separate sampled-thread traces were collected for TUI `gsc` and `gsgen`.
Tracing substantially increased elapsed time. Use these traces to locate
work, not to predict exact untraced savings or to equate samples with CPU
cycles. Inclusive categories overlap.

In `gsc`, `EnumerateTypeAliasesInChain` occupied about 1.515 seconds of the
8.431-second sampled `Program.Main` interval. Imported extension-method
collection occupied about 0.659 seconds. In `gsgen`, stub projection
occupied about 2.367 seconds of the 3.806-second sampled `Run` interval.
The latter enters global binding, but not body binding.

Source inspection explains those observations:

- `BoundScope.TryResolveCollidingTypeAliasByImport` scans every visible
  alias even when a name has no collision. Unknown-arity nested lookups
  also enumerate the alias chain. Enumeration allocates a `HashSet` and
  walks immutable-dictionary builders.
- `MemberLookup.CollectImportedExtensionMethods` repeatedly enumerates
  methods on imported extension-holder classes. The existing holder-class
  cache does not index those methods by name.
- `ReferenceResolver` lazily constructs several related metadata-name
  indexes. It already exposes `ExportMetadataIndex` and
  `TryUseMetadataIndex` for ADR-0107; reuse that work before inventing
  another metadata-cache format.
- `GeneratorHostRunner.RunFromAnalyzerPaths` projects and binds the stub
  before `GeneratorRunner` discovers the actual generators.
- `BuildTask` and `GsgenTask` each start a fresh `dotnet` process for each
  project. `gsc` and `gsgen` separately parse and bind declarations.

The Core API probe allocated about 2.62 GB on its first compilation; TUI
allocated about 1.26 GB. Those are allocated bytes, not retained memory.
Repeated whole-scope scans and metadata materialization deserve attention
before allocating multiple independent copies of the binder.

The larger compiler workload strengthens that priority. A separate
10-second sample during its excluded warmup was entirely inside body
binding. `EnumerateTypeAliasesInChain` appeared in 9.484 of 10.075 sampled
seconds, about 94%. Most of that interval descended into immutable
dictionary enumeration and write-barrier copying. This is a localized
sample, not a claim that 94% of the complete build is removable.
The same enumeration path also appeared in the smaller Oahu profile.
Fixing lookup complexity is therefore a more concrete first experiment
than adding threads to the current full-alias scans.

An IL inspection and a separate executing probe also found missing nested
enumerator cleanup when a `for ... in` body yields. Full consumption and
early disposal both produced zero nested `Dispose` calls; a C# control
produced one in each case. This is tracked separately as **#5037**.
It is a correctness prerequisite to investigate alongside state lifetime,
not a measured explanation of all copying or retained memory.

## Decision

Adopt a measured throughput program, in the order below. Keep the compiler
in G#, keep Roslyn in the sibling generator host, and keep project-graph
scheduling in MSBuild. Do not adopt a wholesale TypeScript-style checker
clone or promise a speedup based on core count alone.

### 1. Make phase measurements a supported compiler facility

Add opt-in structured timings for source loading/parsing, reference setup
and lazy indexing, declaration binding, body binding, whole-program
analyses, each lowering pass, implementation emit, reference emit, PDB,
documentation, and analyzers. Give `gsgen` corresponding discovery,
projection, generator, translation, and output stages.

Record elapsed and CPU time, allocated bytes, peak process memory, source
and method counts, cache hits, worker budgets, and tool versions. Keep
normal diagnostics and stdout behavior unchanged. Identify overlapping
tasks and nested phases instead of presenting their sums as wall time.
The measurement host is exploratory evidence, not a replacement for
instrumenting the actual driver.

### 2. Remove repeated lookup work before parallelizing it

Index alias candidates by simple name and arity, and nested aliases by
owner identity and name. Use the existing exact-key lookup for ordinary
cases. Preserve nearest-scope shadowing, preferred/lowest arity, package
qualification, same-file imports, and ambiguity diagnostics.

Maintain the candidate index as declarations enter the scope, then publish
an immutable declaration snapshot for body binding. Do not cache a
context-dependent final answer under a name-only key. Scope changes,
current syntax tree, package hints, and imports remain semantic inputs.
Reuse the existing source-extension name-index pattern in `BoundScope`.

Add a name-indexed imported-extension candidate cache within the correct
reference/import context. Preserve accessibility and friend-assembly
filtering. Cache repeated record-shape classification, including negative
results, without conflating CLR types from different load contexts.

Reuse and extend the existing reference metadata index. Cache immutable
metadata descriptions, not disposed `Type` objects or symbols belonging
to another compilation. A persistent cache needs content-sensitive
fingerprints, reference ordering, compiler/schema version, target
framework, and relevant options; assembly name/version alone is not
enough. Nullability queries must continue through the existing producer
and reader APIs, with their complete context.

These changes attack measured work without creating concurrency hazards.
Their speedup is not yet measured. The samples identify candidates, not
proof that every millisecond in those stacks can disappear.

### 3. Amortize compiler and generator setup safely

Prototype a versioned, bounded pool of reusable compiler processes.
Start with **one active compilation per worker**. `ReferenceResolver.Dispose`
currently clears process-wide symbol/member caches; concurrent requests
cannot assume those caches are independently owned.

Pass working directory, response arguments, cancellation, environment
inputs, and an explicit resource budget as request data. Preserve
structured diagnostics and exit status. Keep worker lifetimes bounded;
retire workers by memory/request limits until retention is understood.
The six-request retention result above blocks an unbounded persistent
worker. Address #5037 separately and identify the retaining roots; do not
assume fixing one also fixes the other.
Test process loss and cancellation. Log any transport fallback explicitly;
do not turn compiler failures into a successful retry result.

Treat a reusable `gsgen` host as a separate experiment. Preserve ADR-0027's
Roslyn boundary. Dispose its reference contexts and isolate generator
loading/lifetimes before reusing a host. Reuse the Roslyn incremental driver
only with a correct input identity and invalidation model.

Discover actual generators before paying for stub projection when there
are no generators. Preserve foreign C# translation and load diagnostics.
This fast path alone will not remove Oahu's 15 launches: its projects
include real framework generators even when their output manifests are
empty. Never infer future generator behavior from a previous empty output.

Avoid binding the same declaration surface twice where a measured,
validated reusable representation can cross the host boundary. Do not
reuse a pre-generator global scope as the final scope after generated
partial declarations change it.

### 4. Add bounded file parsing, then body-level parallelism

Parallel file loading and parsing is the first low-risk threading slice.
Each file owns its lexer, parser, and diagnostics. Publish the resulting
trees in the original response-file order, not completion order.
Retain a sequential path for small inputs and diagnosis.

Body binding is the high-value, higher-risk slice. First complete the
declaration/inferred-signature barrier. Then bind independent bodies using
worker-local binder state and diagnostics. Merge by stable declaration and
source order.

This is not a `Parallel.For` around today's `Binder.BindProgram` loops.
The shared parent scope owns anonymous-type and synthesized-delegate
caches, structural adapters, rich-anonymous plans, and mutable builders.
Some inferred rich-anonymous returns are resolved before the ordinary
body loop. Those dependencies must remain explicit. `AsyncLocal` package,
file, and nullability context does not make these shared objects immutable.

Use stable owner-based identities for synthesized artifacts. Keep shared
type identities canonical. Stage synthesis and deterministic merging
where necessary; retain a serial path for work whose dependencies have
not yet been separated. Run suspension inference, managed-reference
safety, and other whole-program analyses after the required body barrier.

Unlike TypeScript's documented checker-count caveat, G# must produce
the same semantics, diagnostics, and deterministic outputs at every
supported worker count. Worker count is a performance option, not a
language-semantics option.

### 5. Parallelize lowering and method emission only after planning

Keep cross-body discovery, stable synthesized names, type/method identity
assignment, metadata handles, and final metadata/PDB serialization ordered.
Parallel workers may produce method-local lowered bodies, IL buffers,
relocations, and debug records once their inputs and handles are fixed.

Do not share today's `MetadataBuilder`, `MetadataTokenCache`, or mutable
generic-remap state between emit workers. A lock around the current emitter
would serialize the expensive path while adding contention.
Discovery must include initializer plans as well as `Program.Functions`.
Keep implementation and reference emission separate in timings; investigate
reusing their stable plan before duplicating planning work.

This is a later phase. The current Oahu phase measurements put a much
larger cost in binding than in lowering plus emit.

### 6. Cooperate with MSBuild's resource allocation

MSBuild already owns dependency ordering and project parallelism. G# owns
parallel work inside one project. Do not build a second solution scheduler.

`IBuildEngine9` provides `RequestCores` and `ReleaseCores`. The SDK task
should request a bounded allocation once, pass the granted limit to the
child/worker, and release it on completion or cancellation. Avoid repeated
blocking requests while holding a partial allocation. Use a conservative
single-worker fallback where the engine interface is unavailable.

The same budget applies across concurrent parse, bind, lower, and emit
activities within that request; each phase must not create an independent
full-machine pool. Generator-host work needs coordinated accounting too.
Use one compiler worker-budget setting, also exposed through the SDK,
rather than independent knobs that multiply each other's parallelism.
Cap memory as well as concurrency. Do not assume a fixed `-m` value means
that every node is always runnable, or that MSBuild's advisory API alone
accounts for every uncooperative process on the host.

Benchmark node counts and compiler worker counts independently, including
the narrow tail of the project graph. Preserve normal MSBuild incremental
checks and reference-assembly copy-if-different behavior.

## TypeScript 7: what transfers

This study uses the July 8, 2026 TypeScript 7 release explanation and
pinned current Go source, not only the March 2025 announcement. The
headline native-port speedup combines several changes. It is not evidence
that adding threads to an already-.NET compiler provides a tenfold gain.

| Mechanism | TypeScript evidence | G# decision |
| --- | --- | --- |
| File-level parse/load work | `filesparser.go` queues work, deduplicates paths, and later assembles the file collection | Transfer independent parsing and ordered publication. G# gets its initial file list from MSBuild, so it need not reproduce TypeScript's import-driven loader |
| File-local binding | `Program.BindSourceFiles` queues bind work per file | Do not equate this with G#'s cross-file global declaration and body binding. Establish G#'s own phase boundaries first |
| Private checker state | `checkerpool.go` maintains checker-local caches and deterministic file associations | Transfer ownership isolation, not wholesale duplicated G# worlds. G# bound nodes and CLR emit rely on canonical symbol identities |
| Work partitioning | Current checker pool uses weighted import-graph partitioning, with stable ties and file order | Begin with simpler stable body batches. Adopt affinity-aware partitioning only if measured duplication or imbalance warrants it |
| Parallel emit | `Program.Emit` uses separate per-file emitters/writers and combines results in input order | Transfer local output buffers and ordered merge. G# writes one PE with shared metadata tables, not independent JavaScript files |
| Project builders and worker controls | Release documentation distinguishes builders, checkers, and single-threaded mode | Use MSBuild for builders; expose and budget within-project workers. Avoid multiplying full-machine pools |
| Memory tradeoff | Additional checkers duplicate some semantic work and state | Prefer removing repeated work and sharing immutable descriptions before replicating expensive reference/binder state |

The current TypeScript workgroup implementation uses Go concurrency;
it is not a drop-in .NET scheduling design. The useful principles are
ownership, explicit barriers, deterministic combination, locality, and
measured resource limits.

## Expected gains and limits

Separate observations, upper bounds, and implementation targets:

| Change | Evidence today | What can be claimed |
| --- | --- | --- |
| Four-worker parse | Existing API microbenchmark | Roughly 58-65 ms saved on these first parses; no end-to-end implementation claim |
| Reuse compiler process | Ten calls through the real driver | 3.34x / 3.73x first-to-late improvement on repeated Core/TUI inputs; not a service or solution-build prediction |
| Alias and extension indexing | Source inspection plus sampled hotspots | Concrete optimization targets; no measured implementation speedup yet |
| Generator setup/projection reuse | 34.665 task-seconds in one full rebuild and projection-dominated trace | Material separate budget to reduce; not all of it is removable |
| Four-way body binding | Phase timings and Amdahl calculation | Optimistic bound only; dependencies, JIT, allocation, and scheduling prevent perfect scaling |

For Core, replace the 3.876-second body bucket with one quarter of itself
while keeping every other first-call bucket unchanged. The result is about
3.00 seconds, versus 5.905 seconds originally and 0.970 seconds for the
standalone C# compiler. Even zero-cost body binding leaves about 2.03
seconds. For TUI, the same ideal four-way model gives about 2.44 seconds,
versus 4.044 seconds originally and 0.847 seconds for C#.

These are arithmetic bounds for the API probe, not forecasts for the
driver. They demonstrate why **body parallelism alone is insufficient**.
The plan must combine less work, amortized setup, and useful concurrency.
Do not multiply independent microbenchmark speedups into a promised
solution-build time.

## Implementation gates

1. Preserve this baseline and add supported driver timings. Repeat on a
   reserved host before using small percentage changes as release gates.
2. Land one lookup/allocation optimization at a time. Require unchanged
   diagnostics and output plus a measured reduction in its actual phase.
3. Prototype process reuse separately from semantic parallelism. Check
   alternating projects, different references with identical assembly
   names, target frameworks, options, nullability modes, generator
   versions, failures, cancellation, and memory after collections.
4. Introduce bounded parse and body workers behind explicit opt-in flags.
   Compare worker counts 1, 2, 4, and 8 across repeated fresh processes.
   Require deterministic DLL/reference/PDB bytes where the current driver
   promises them, stable diagnostic order, valid IL, and unchanged runtime
   behavior. Stress nested types, imports, partials, inferred signatures,
   anonymous types, closures, initializers, and async/iterator synthesis.
5. Promote defaults only after full Oahu builds and the large compiler
   workload improve under realistic MSBuild node budgets and memory caps.
   Restore excluded, compare both shipping settings and equivalent
   non-shared settings. Add body-only and public-signature edit scenarios;
   neither no-op timing nor same-input process reuse measures these.
   The final target is G# elapsed time no greater
   than C# on both declared workloads, not merely a faster isolated phase.

Use ADR-0154 discrimination witnesses for behavioral changes. Performance
evidence must fail the old implementation on the measured dimension rather
than only assert that a stopwatch ran. Preserve the N-1 rule: implementation
source must build with the committed released SDK. Pin moves remain
separate PRs. Full stage-2 certification is not made a new PR requirement.

## Consequences

### Imported metadata facts (#5070)

Open CLR declaration lookups share a weak, target-type-owned cache of successful
token matches. Each hit checks the actual module object. The key includes the
original member kind, flags, name scope and reflection view. Direct reflection
retains its existing load-failure behavior; signature-filtered callers reuse
the existing member arrays. A scan stops at its original first match.
The cache stores only members enumerated from its target, never a foreign
request's module or constructed generic arguments under a live host type.

The nullability funnel also reuses successful attribute reads and immutable
raw `Nullable` and `NullableContext` bytes under weak actual-provider keys.
Successful absence is cached; failed attribute reads remain retryable.
Receiver substitution, ambient nullability options, tuple names, by-ref storage,
default-value lifts and flow contracts retain their existing readers and rules.
No final `TypeSymbol` is cached by this mechanism.

Opt-in counters distinguish definition requests, scans, inspected members and
successful cache entries, plus contract requests, attribute reads and raw
nullable/context decodes. Entries distinguish reflection views and are not a
count of unique logical members across contexts. These counters describe work,
not a measured build-speed gain.

The October 20 comparison rebuilt baseline `68acf272c` and candidate `7a38e2e69`
with published SDK `0.5.179` and .NET SDK `10.0.400`. It does not compare the
candidate against the older `4e1a4430` private SDK. Separate owned copies replayed
the fixed Core `c7b82dcb` and Oahu.Core `9db7f232` inputs through explicit compiler
paths. Missing captured AssemblyInfo, resource and analyzer inputs were rebuilt
with the published SDK in those copies. Oahu dependency references were rebuilt
with the current-source baseline and shared by both variants. Source Link maps
the owned paths to the pinned repository commits. The manifest hashes source,
reference, resource, Source Link, analyzer and toolchain files.

The twenty successful fresh-process requests comprise two excluded warmups,
three alternating measured pairs and two separate profiles per workload.
Timed requests disable measurements. Options retain four workers, a 1024 MiB
budget, optimization, deterministic output, portable PDB, reference output and
XML documentation. These are direct compiler requests, not solution rebuilds.
One earlier excluded warmup failed on the missing captured analyzer image.
Its log and original manifest are retained; no successful sample was discarded.

| Direct compiler wall time, seconds | Baseline median (range) | Candidate median (range) |
| --- | ---: | ---: |
| Core | 40.952 (40.390–41.855) | 41.940 (40.431–42.308) |
| Oahu.Core | 4.385 (4.175–4.400) | 3.950 (3.931–4.319) |

Core's candidate median is 2.4% slower: this does not demonstrate a Core
throughput gain. Oahu.Core's candidate median is 9.9% lower in these three
pairs, not a general compiler or solution-build speedup. Both ranges overlap.
The shared-desktop samples do not establish confidence intervals.

Separate untimed profiles record the actual metadata work:

| Counter | Core baseline → candidate | Oahu.Core baseline → candidate |
| --- | ---: | ---: |
| Definition requests | 47,484 → 47,484 | 3,724 → 3,724 |
| Distinct successful reflection-view keys / entries | 389 → 389 | 96 → 96 |
| Member-array scans | 47,484 → 389 | 3,724 → 96 |
| Members inspected | 361,857 → 8,355 | 10,353 → 1,514 |
| Contract requests | 99,687 → 99,687 | 10,088 → 10,088 |
| Raw attribute reads | 244,939 → 10,140 | 21,693 → 2,670 |
| Nullable decodes | 99,687 → 6,532 | 10,088 → 1,804 |
| NullableContext decodes | 132,507 → 3,288 | 10,750 → 857 |

The instrumented compilation allocation observations were 15,305.9 → 15,098.3
MiB for Core and 1,028.2 → 1,006.4 MiB for Oahu.Core. Their nested body phases
were 9,447.9 → 9,282.0 MiB and 592.4 → 571.8 MiB respectively.
These are single process-inclusive observations, not retained memory.
Counter overhead is included and counter frequencies differ; the baseline
overlay also records distinct keys. They are not exact uninstrumented
production-allocation savings. Do not add nested phases.

Every successful request produced nonempty implementation DLL, reference DLL,
portable PDB and XML output. All four matched byte-for-byte across variants,
warmups, samples and profiles for each workload. Exact diagnostics also matched,
including the captured Core closure's existing GS9100 warning without suppression.
No output normalization or byte masking was needed. This establishes metadata
work reuse with unchanged output, not a general throughput improvement.

### Local declaration discovery reduction (#5055)

The generator projection and compiler keep separate declaration scopes.
Those scopes contain mutable symbols and bound initializers; generated partials
require a fresh binding pass. No live scope crosses the host boundary.
The existing reference metadata index is content-validated, but exporting and
transporting it is not adopted without a measured benefit.

Both declaration passes previously searched every syntax node for rich anonymous
objects, even when the parser constructed none. Anonymous-expression construction
now records a conservative presence summary on its owning syntax tree.
Trees without anonymous expressions skip this discovery walk. Other trees keep
the existing walk, generic context and synthesis order. Interpolation subparsers
record against the same tree. Speculative parsing can cause an extra walk, never
a missing declaration. A new parse owns a new summary, so source edits and
membership changes cannot reuse stale absence.

This local reduction does not cache projection or generation results.
References, options, generator bytes, additional files and their metadata still
flow through the existing driver and SDK invalidation paths. Empty generator
output never suppresses execution or diagnostics. Last-good output, retries,
orphan cleanup and task-owned success stamps retain their existing authority.
Optional measurements count scanned and skipped trees separately.

The October 20 comparison used the fixed compiler `c7b82dcb` and Oahu
`9db7f232` workloads above. Both tool variants used the verified
`0.5.7-perf2189.s2` benchmark bootstrap from `4e1a4430`; only their rebuilt
Core DLL/PDB payloads differed. The production pin was `0.5.7` during this
comparison. This change was later rebased onto the separate published
`0.5.179` pin update (#5059). Current-pin validation is separate from the
original controlled samples, which retain their original inputs and payloads.
Each variant received one warmup and three alternating measured rebuilds,
with restore excluded, four MSBuild nodes and the existing opt-in four-worker
settings. All samples were retained.

| Rebuild wall time, seconds | Baseline median (range) | Changed median (range) |
| --- | ---: | ---: |
| Compiler product graph | 57.683 (57.358-59.256) | 57.995 (57.672-58.286) |
| Complete Oahu solution | 30.530 (30.449-31.406) | 30.731 (30.382-31.767) |

There is no demonstrated build-speed gain. The changed medians were 0.5%
and 0.7% slower, with overlapping ranges. The desktop remained shared;
recorded load rose during Oahu runs. No sample was removed as an outlier.

Separate untimed real-driver profiles measured the local reduction:

| Request or phase | Baseline seconds / allocated MiB | Changed seconds / allocated MiB |
| --- | ---: | ---: |
| Core generator request | 10.721 / 3734.0 | 10.411 / 3065.8 |
| Core generator projection, nested in that request | 7.397 / 3088.1 | 7.093 / 2420.9 |
| Core compiler declarations | 7.276 / 3079.1 | 7.290 / 2669.1 |
| Oahu UI generator request | 5.795 / 496.8 | 6.707 / 500.0 |
| Oahu UI generator projection, nested in that request | 0.505 / 173.4 | 0.436 / 169.5 |

These are single process-inclusive observations, not timing medians or retained
memory. Do not add nested rows. Core avoided 700 whole-tree discovery walks
in each declaration pass. Its projection allocated 667.3 MiB less (21.6%);
compiler declarations allocated 409.9 MiB less (13.3%). Oahu UI avoided
16 walks. All seven Core generators still ran with zero documents; Oahu UI
still ran 17 generators and produced 36 documents. The slower changed Oahu UI
request is retained, not credited as a latency improvement.

All captured implementation/copied/reference DLLs, PDBs, XML files and manifests
matched byte-for-byte. Oahu's 38 nonempty generated G# files also matched.
This is an allocation and work reduction, not cross-stage declaration reuse:
parsing, semantic declarations and reference import still run separately in
`gsgen` and `gsc`. Their remaining duplication stays outside this local change.

### Generated-document translation work reduction (#5054)

Back-translation retains the immutable Roslyn input/generated trees and metadata
references from generator setup. Import reservation now uses the active document's
semantic model instead of rebinding that tree through a second model. A model
that ignores accessibility retains the prior separate-model path.
Source-name censuses visit the current assembly and globally visible
compilation references, not metadata-only assemblies whose types cannot have
source locations. Reference aliases and source-symbol rebinding remain inputs.
Per-document alias state, translation order, diagnostics and output publication
are unchanged. This reduction adds no cache, worker pool or SDK bypass.

On the pinned Oahu workload, same-bootstrap unmodified/fixed host payloads differed
only in the translator DLL, PDB and XML. One warmup per variant preceded alternating
timed rebuilds; separate instrumented builds measured the actual reusable-worker
translation request. The existing opt-in four-worker, four-node configuration
and the compiler payload stayed fixed.

| October 20 follow-up | Before | Fixed |
| --- | ---: | ---: |
| Complete Oahu rebuild median, three pairs | 32.710 s | 29.146 s |
| Oahu.UI translation median, three separate actual-worker probes | 3.601 s | 3.191 s |
| Translation allocations, median process delta | 251.9 MB | 79.6 MB |
| No-op median, two runs per variant | 3.464 s | 3.477 s |

All 38 generated filenames and contents matched across full builds, including
Oahu.UI's 36 documents. No-op logs contained no compiler or generator task.
These shared-desktop samples are not confidence intervals or a general speedup
promise. Separate cold-host phase probes were noisy and had a slower fixed median
(3.406 s versus 3.671 s), despite the same allocation reduction. Their latency
does not establish a cold translation improvement. Nested phase costs are not
additive; timed solution rebuilds had instrumentation disabled.

### Initial bounded-worker implementation (#5041)

The initial implementation remains opt-in (`GSharpMaxWorkers=1` by default).
One SDK task lease calls `IBuildEngine9.RequestCores(requestedTotal)` once,
then releases the returned total in `Dispose`, including cancellation and
failure paths. The first request includes the task's implicit core and does
not block. Unsupported hosts use one worker. A reusable process receives a
fresh grant per request, not a process-lifetime core allocation.

`CompilationWorkBudget` is shared by sequential phases. Its indexed work
runner owns at most the granted number of active operations, joins every
operation before returning, rethrows failures in input order, and rejects
nested or overlapping use. It bounds workspace concurrency using a 256 MiB
reserve, 96 MiB per worker, and larger source/body estimates. This is not
a hard limit on total heap, retained output, or third-party generator threads.
The default workspace budget is 1024 MiB. Processor count also caps workers.
The compiler exposes `--workers:N` and `--worker-memory-mib:N`.
Cold microbenchmarks showed scheduling overhead on tiny inputs. Parsing
stays sequential below four files and 64 KiB. Body eligibility is not
computed below eight candidates when every body is smaller than 8 KiB.
Larger phases still obey the shared grant and workspace limits.

Parsing owns one lexer/parser/tree per input slot. Body binding first
completes declarations, field initializers, and rich inferred return bodies.
The inferred-return pass includes static members and uses the same canonical
declarations as the later body pass. Host assembly candidates are captured
before workers run, so runtime scheduling dependencies cannot change the
implicit reference universe or its PDB metadata.
The first worker eligibility proof accepts only primitive operations over
parameters and body-owned locals. Calls, imported member access, type
construction, lambdas, anonymous objects, adapters, generics and unknown
syntax remain coordinator-owned. These are explicit concurrency limits, not
claims of general body independence.
Instance-member scopes also stay coordinator-owned. Their implicit receiver
and inherited pseudo-bindings require the binder's scope reader before
their parameters can be proved lookup-visible. Free/static functions retain
the primitive/local worker path.

Each eligible body owns its binder context, diagnostics, scopes and lowered
result, but keeps the original canonical symbols. A scope boundary fails
loudly if a worker reaches anonymous/delegate/adapter/rich-object registries
or the deferred-constraint queue. The coordinator does not mutate declarations
while workers run. It then merges each result and its diagnostics at the
original binding position. Other bodies retain their established order and
synthesized identities. Suspension inference and reference-safety analyses
remain after the joined body barrier.

Widening eligibility requires proving the additional shared state safe; it
must not replace this proof with a syntax denylist or concurrent dictionaries.
Full-workload measurements and default promotion remain separate acceptance
work, as specified above.

### Method-local emission boundary (#5042)

Emission keeps closure and state-machine discovery ordered, including
`BoundProgram.Initializers`. It fixes synthesized identities, generic remaps
and method handles before scheduling eligible method bodies. Workers use the
existing instruction emitter with method-owned labels, locals, IL buffers and
unresolved sequence points. An isolated emitter has no coordinator reference:
an attempt to use metadata, token caches or mutable generic remaps fails.
Primitive local-slot and label allocation also runs in the owned workspace.
It uses the normal planner's allocation helpers, without shared metadata or
by-ref type construction.
The coordinator commits local signatures, body offsets, document handles and
debug records in the existing method order. Metadata and PDB serialization
remain sequential. Reference emission never schedules instruction generation.
It also retains proven primitive lambdas' original bodies for discovery instead
of repeating their control-flow lowering. Those bodies need neither IL slots
nor debug records in a reference assembly. Closure, state-machine and metadata
plans remain emission-owned; they are not shared as mutable state between outputs.

The initial eligibility proof accepts primitive arithmetic and control flow
over body-owned locals and parameters. Calls, strings, conversions, captures,
by-ref operations, exception regions, suspension and unknown nodes retain the
existing coordinator path. Noncapturing primitive lambda bodies can also use
method-local lowering after ordered discovery. This does not duplicate the
body-binding lowerer scheduled by #5041.

The same request budget joins each lowering and instruction batch. One worker
keeps the original instruction path. Measurements separate discovery,
emit-lambda lowering, local planning, instruction generation, implementation
and reference emission, PDB construction, PE serialization and documentation.
Parallel-batch counters require observed overlap of real instruction work;
starting a timer or using a second thread is not evidence of parallel emission.
Nested phase totals remain nonadditive.

Tiny local batches retain sequential execution under the existing eight-body
or 8192-source-character guard. Non-debug workspaces do not retain sequence
points. All requested outputs are staged before the request's final cancellation
check. Publication then completes without intermediate cancellation checks.
Cancellation observed before that boundary publishes no artifact; cancellation
requested by a destination write cannot leave the reference pass uncomputed.
Destination I/O failures still follow the caller's stream contract, not a
transaction across arbitrary external streams. Staged output is retained output,
not part of the concurrent workspace memory estimate.

The work prioritizes measured bottlenecks and preserves the existing
compiler and SDK architecture. Small sequential improvements can land
before the larger concurrency work. A stable phase model makes later
decisions testable.

Persistent workers and body parallelism require lifecycle and ownership
work. Extra cores can increase allocation, memory, and duplicated work.
The two workloads are useful baselines, not proof of performance on every
program or machine. The compiler-branch comparison also includes source,
analyzer, and bootstrap-version differences.

## Alternatives considered

- **Parallelize everything immediately.** Rejected: shared binder and emit
  state is not safely partitioned, and small parse time limits its payoff.
- **Copy TypeScript's checker count and graph partitioner.** Rejected as a
  starting point: the work units, symbol identities, output format, and
  external build scheduler differ.
- **Rewrite gsc in Go or restore the Roslyn fork.** Not justified by these
  measurements and outside ADR-0027's accepted direction.
- **Disable generators, diagnostics, nullability checks, documentation,
  or reference output to claim parity.** Rejected as a product change.
  Controlled diagnostic experiments must be labeled as such.
- **Use a process-wide unbounded metadata/symbol cache.** Rejected:
  load-context identity, invalidation, and retention are correctness and
  memory constraints, not optional details.
- **Start with NativeAOT or early reference-assembly publication.**
  Deferred. They add packaging/reflection or build-graph complexity.
  First measure setup amortization and the existing phase costs.

## References and reproducibility

The local raw evidence is retained under the benchmark session's
`files/oahu-benchmark/`: runner and probe sources, individual JSON samples,
text logs, binary logs, response-command captures, and two sampled traces.
The additional compiler warmup trace and cleanup/retention probes are
retained there too. An evidence archive is stored at
`$HOME/.cache/gsharp-2189-oahu-20261019/benchmark-evidence.tar.gz`.
The four pinned source checkouts remain under that work root for follow-up
measurements; generated build outputs were cleaned after archiving evidence.
No raw binary logs are published: they may include machine-specific build
environment information.

Reproduction requires full git history for Oahu's version-height task.
Use the commits above, restore before timing, and keep benchmark work roots
off `/tmp`. For the normalized full-solution run, append
`-p:UseSharedCompilation=false -p:GenerateDocumentationFile=false`.
For no-op builds, omit `-t:Rebuild`.

For the large compiler workload, substitute
`src/Compiler/Compiler.csproj` or `src/Compiler/Compiler.gsproj` for the
solution and retain `-graph`. Do not accidentally benchmark the entire
repository's test/tool/extension solution as "the compiler."

Relevant local source, at the inspected G# main commit:

- `src/Compiler/Program.gs:249-367`: sequential source load, references,
  compilation setup, and emit.
- `src/Core/CodeAnalysis/Compilation/Compilation.gs:288-339,541-679`:
  declaration/body barriers, lowering, implementation/reference emission.
- `src/Core/CodeAnalysis/Binding/BoundScope.gs:1135-1330,1944-2040`:
  alias lookup and full-chain enumeration.
- `src/Core/CodeAnalysis/Binding/MemberLookup.gs:304-412`:
  imported extension candidates and the existing holder-class cache.
- `src/Core/CodeAnalysis/Symbols/ReferenceResolver.gs:235-294,790-846`:
  disposal and existing metadata-index export/adoption.
- `src/Core/CodeAnalysis/Binding/Binder.gs:7678-8359`: shared binding
  state, inferred-body ordering, and whole-program analysis.
- `src/Core/CodeAnalysis/Emit/SlotPlanner.gs:88-150`:
  deterministic discovery including initializer plans.
- `src/Sdk/Gsharp.NET.Sdk/BuildTask.gs:319-371` and
  `GsgenTask.gs:190-253`: per-project child-process boundaries.
- `tools/gsgen/Gsgen.Cli/GsgenProgram.gs:40-109` and
  `tools/gsgen/GSharp.GeneratorHost/GeneratorHostRunner.gs:50-73`:
  generator-host setup and projection before generator discovery.

Primary external sources:

- [TypeScript 7 release and parallelism controls](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
- [Pinned TypeScript file parser](https://github.com/microsoft/TypeScript/blob/28534d7609062699a68b1b66e2367f8d95dbf290/tsc/internal/compiler/filesparser.go).
- [Pinned TypeScript checker pool](https://github.com/microsoft/TypeScript/blob/28534d7609062699a68b1b66e2367f8d95dbf290/tsc/internal/compiler/checkerpool.go).
- [Pinned TypeScript bind and emit orchestration](https://github.com/microsoft/TypeScript/blob/28534d7609062699a68b1b66e2367f8d95dbf290/tsc/internal/compiler/program.go).
- [Pinned TypeScript workgroups](https://github.com/microsoft/TypeScript/blob/28534d7609062699a68b1b66e2367f8d95dbf290/tsc/internal/core/workgroup.go).
- [MSBuild resource-management design](https://github.com/dotnet/msbuild/blob/main/documentation/specs/resource-management.md)
  and [actual `IBuildEngine9` API](https://github.com/dotnet/msbuild/blob/main/src/Framework/IBuildEngine9.cs).
- [Roslyn compiler-server design](https://github.com/dotnet/roslyn/blob/main/docs/compilers/Compiler%20Server.md):
  JIT amortization, metadata caching, and the difference between MSBuild
  node reuse and shared compilation.
