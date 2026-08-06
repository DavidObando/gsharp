# ADR-0156: Emit-to-memory execution for gsi and bare gsc

- **Status**: Accepted — Phases 1–3d implemented, campaign complete (Phase 3c, [#3176](https://github.com/DavidObando/gsharp/issues/3176): the tree-walking evaluator, `Compilation.Evaluate`, the evaluator SessionEngine, and the `--engine evaluator` escape hatch were deleted; Phase 3d removed stale evaluator guidance, pinned the website `gsi --help` transcript, swept the residual docs/sample references, trimmed the dead `Compilation.Previous` / `StructValue` evaluator seams, and made package-declaring REPL cells echo and chain correctly; the conformance gate is the two-host emitted parity gate)
- **Date**: 2026-08-03
- **Phase**: Interpreter conformance / execution architecture
- **Related**: #3176 (tracking), #3163 (code-health P2 headline item), ADR-0152
  (interpreter native-call boundary), ADR-0153 (interpreter compiled-only
  storage boundary), ADR-0154 (test oracle strength), ADR-0068 (`deinit`
  destructor support); divergence instances
  [#3140](https://github.com/DavidObando/gsharp/issues/3140),
  [#3134](https://github.com/DavidObando/gsharp/issues/3134),
  [#3116](https://github.com/DavidObando/gsharp/issues/3116),
  [#3110](https://github.com/DavidObando/gsharp/issues/3110),
  [#3100](https://github.com/DavidObando/gsharp/issues/3100),
  [#3099](https://github.com/DavidObando/gsharp/issues/3099),
  [#3022](https://github.com/DavidObando/gsharp/issues/3022),
  [#3006](https://github.com/DavidObando/gsharp/issues/3006),
  [#3004](https://github.com/DavidObando/gsharp/issues/3004),
  [#3003](https://github.com/DavidObando/gsharp/issues/3003),
  [#3050](https://github.com/DavidObando/gsharp/issues/3050),
  [#3114](https://github.com/DavidObando/gsharp/issues/3114),
  [#3137](https://github.com/DavidObando/gsharp/issues/3137); feature gaps
  [#3130](https://github.com/DavidObando/gsharp/issues/3130),
  [#2190](https://github.com/DavidObando/gsharp/issues/2190)

## Context

Before this decision, G# had three execution drivers and two execution engines.
`gsc /out:` emitted IL
through `ReflectionMetadataEmitter` and the program runs on the CLR. Bare `gsc`
(no `/out:`) and `gsi` both called `Compilation.Evaluate`, which walks bound
trees with the `Evaluator` — ~7,300 lines across seven partial files in
`src/Core/CodeAnalysis/Evaluator*.cs`. The two engines do not even consume the
same trees: the emit path runs `InterpolatedStringHandlerLowerer`,
`SideEffectSpiller`, `CaptureBoxingRewriter`, `ExpressionTreeLowerer`,
`BaseCallForwarderRewriter`, and the async/iterator state-machine rewriters;
the evaluate path runs only `CaptureBoxingRewriter` and interprets everything
else directly (`Compilation.cs`). The evaluator is therefore a second,
structurally divergent implementation of the language.

Every semantic feature must land twice, and when the copies disagree the
failure shape is the worst the toolchain can produce: **exit code 0, no
diagnostic, wrong answer**. The program runs to completion and quietly
computes with wrong values. One month of measured instances of exactly this
class: #3140 (`out` write-back silently dropped for class instance methods),
#3134 (classes given value equality instead of reference identity), #3116
(struct `Equals`/`GetHashCode` overrides ignored when the BCL calls them —
`Dictionary.Count` differs by driver), #3110 (constant-pattern equality
diverges), #3100 (`@FieldOffset` overlap ignored), #3099 (struct/enum type
arguments erased to `System.Object`), #3022 (ref-aliasing local re-evaluates
its initializer), #3006 (exhaustive enum `switch` silently falls through),
#3004 (stale pointer dereference with exit 0). Alongside the silent-wrong
class sit hard capability gaps that exist only because the evaluator exists:
#3003/#3050 (lambda shapes crash under gsi), #3114 (ByRefLike signatures fail;
two shipped samples), #3137 (reified CLR type arguments have no members),
#3130 (gsi has no `/r:` reference channel), #2190 (interpreter performance),
plus the deliberate boundaries of ADR-0152 (no P/Invoke) and ADR-0153 (no
pinning/stackalloc/pointer storage) and the deinit gap (GS0510).

The cost is structural, not incidental. #3163 measured roughly half of recent
fix commits paying an evaluator-parity tax, and the conformance gate
(`test/Compiler.Tests/LanguageConformance/SampleConformanceTests.cs`) carries
a growing `ExpectedDifferences` table of known, documented divergence. The bug
class regenerates faster than it is fixed because its cause — two independent
implementations of one semantics — is still in place.

Roslyn solved this exact problem for C# interactive: `csi`/scripting does not
interpret; it compiles each submission with the real compiler into an
in-memory assembly, loads it, and runs it. The precedent is directly
applicable because the pieces already exist here:

- `Compilation.Emit(Stream peStream)` already emits a complete PE (entry point
  included) to any stream — no filesystem coupling
  (`src/Core/CodeAnalysis/Compilation/Compilation.cs`).
- The conformance gate already loads emitted bytes in-process
  (`Assembly.Load(File.ReadAllBytes(...)).GetTypes()`) as a smoke check, so
  in-memory loading of gsc output is proven territory.
- `Compilation.ContinueWith` already models chained submissions on the
  front-end side; only its *execution* is interpreter-bound.

## Decision

**Bare `gsc` and file-mode `gsi` stop interpreting. They compile with the real
emitter into memory, load the PE bytes into a collectible
`AssemblyLoadContext` inside the driver process, invoke the entry point, and
surface stdout/stderr and the exit code exactly as today.** Interactive `gsi`
follows the phased migration below. The tree-walking evaluator is retired on a
phased schedule, ending with its deletion or a documented residue. One codegen
pipeline executes everywhere; the divergence class dies by construction.

A shared execution host (working name `EmittedProgramHost`, under
`GSharp.Core.CodeAnalysis.Execution`) owns the mechanics for all drivers:
create a collectible ALC, hook `AssemblyLoadContext.Resolving` to satisfy
framework and `/r:` references from the default context / resolver paths,
`LoadFromStream` the emitted PE, invoke `Assembly.EntryPoint`, map the return
value to an exit code (`int`/`uint`/`void→0`, matching today's gsi protocol),
and unwrap `TargetInvocationException` into the driver's unhandled-exception
protocol.

### Implementation status (2026-08-04)

Phase 1 shipped in #3182. Phase 2's emitted submission engine shipped in #3186,
Phase 3a made it the interactive default in #3201, and Phase 3c deleted the
tree-walking evaluator, `Compilation.Evaluate`, the evaluator `SessionEngine`,
and the `--engine evaluator` / `GSI_ENGINE=evaluator` escape hatches.

| Invocation | Current execution path |
|---|---|
| bare `gsc file.gs` | `EmittedProgramHost.Run` |
| `gsc /out:program.dll file.gs` | emit PE to disk; the CLR runs it separately |
| `gsi file.gs` | `EmittedProgramHost.Run` |
| interactive `gsi` | `EmittedSessionEngine` |

Therefore the former "three-driver" model no longer identifies three
execution semantics: every driver compiles through the emitter. This fully
supersedes ADR-0068's original `deinit` interpreter boundary and the
ADR-0152/ADR-0153 evaluator boundaries.

### Phased migration plan

#### Phase 1 — whole-program drivers: `gsi <file>` and bare `gsc`

Scope: the two non-interactive evaluating paths — `src/Repl/Program.cs` script
mode and `src/Compiler/Program.cs` `Interpret()`. The whole program is
available up front, so there is no incremental-state problem; this phase is
driver plumbing plus the shared host, with **no new compiler surface**
(`Emit(Stream)` exists and the spike below proves the end-to-end mechanic).

- Both drivers build the same `Compilation` they build today, call
  `Emit(MemoryStream)`, and run via `EmittedProgramHost`. Compile diagnostics
  render exactly as today (same bound program, same diagnostics).
- `gsi` gains a `/r:` channel wired to `ReferenceResolver.WithReferences`,
  and the host's `Resolving` hook loads those reference assemblies —
  closing #3130.
- Boundary diagnostics GS0510 (deinit), GS0511 (ByRefLike), GS0513 (storage),
  GS0514 (P/Invoke) stop firing on these drivers because the constructs simply
  work; the corresponding `ExpectedDifferences` rows in
  `SampleConformanceTests` are deleted rather than moved.
- Exit-code/stdout protocol: unchanged from today's contract (entry-point
  return value; diagnostics to the existing writers). Unhandled exceptions in
  user code print the exception to stderr and return a non-zero exit code,
  mirroring the CLR host closely enough that the conformance gate pins it.

#### Phase 2 — interactive REPL: submission chaining

Scope: `src/Repl/Engine/SessionEngine.cs`. This is the hard part, because
interactive state currently lives in interpreter data structures — a
`Dictionary<VariableSymbol, object>` of cell values plus the chained
`Compilation.Previous` scope for symbols.

Compilation model (the Roslyn scripting shape):

- Submission *N* compiles to an in-memory assembly `gsi$N` whose entry type
  (`Submission$N`) holds the submission's top-level variables as **fields**
  and its top-level statements as the body of a factory method that returns
  the trailing expression value (`object`) for the REPL's value echo.
- Submission *N* is bound with references to `gsi$1..gsi$N-1`. Identifier
  lookup that today walks `BoundGlobalScope.Previous` chains instead resolves
  prior-submission variables to fields on the prior submission instances, and
  prior functions/types to ordinary cross-assembly members.
- The session holds one collectible ALC; each submission assembly loads into
  it. `Reset()` unloads the ALC wholesale and starts a fresh chain.

New Core surface (the seam to estimate and design in the Phase 2 issue):

1. **Submission compilation kind** — `Compilation.ContinueWith` (or a sibling
   `ContinueSubmissionWith`) must produce a compilation whose *previous*
   symbols bind as **metadata-backed imports** (through `ReferenceResolver`
   over the prior in-memory assemblies) rather than as source symbols, so
   emit does not try to re-emit prior submissions. This is the largest piece:
   today `Previous` chaining exists only for binder scope reuse and the
   evaluator's variable dictionary.
2. **Global-variable hoisting** — top-level `var`/`let` in a submission emit
   as fields of the submission type instead of locals of `<Main>$`, and the
   binder records the mapping so later submissions bind reads/writes to those
   fields.
3. **Value echo** — the submission factory returns the trailing expression
   value; `Cell.Value` consumes it (replacing `EvaluationResult.Value`).
4. **State sidebar** — `SessionEngine.Snapshot()`'s symbol listing is
   compile-time and keeps working from `GlobalScope`; the *values* column
   switches from the interpreter's variable dictionary to reading the
   submission-type fields via reflection on the live instances.

Estimated seam: binder (submission symbol import + variable hoisting),
emitter (submission type shape, factory return), driver (SessionEngine swap,
ALC lifetime). No changes to the language, the LSP, or `gsc /out:`.

#### Phase 3 — evaluator retirement

- Migrate remaining consumers. Production consumers after Phase 2: none.
  Test consumers: ~314 test files call `Compilation.Evaluate` as a
  convenient semantic oracle. Provide an equally convenient emit-and-run
  helper on top of `EmittedProgramHost` (in `test/Shared`), migrate suites
  incrementally, and mark `Compilation.Evaluate` `[Obsolete]` in the interim.
  Per ADR-0154 the migration itself needs witnesses: a migrated test must
  still fail on its original broken world.
- Delete `Evaluator*.cs` (~7,300 lines), `EvaluatorException`, the
  evaluator-only lowering split, and the interpreter-boundary diagnostics
  GS0510/0511/0513/0514 plus their docs entries.
- ADR-0152 and ADR-0153 are **superseded**: their boundaries exist only
  because an interpreting driver ships. Until Phase 3 completes they remain
  in force for whatever interpreter surface is still reachable.
- If a residue is kept (see Alternatives — none is currently justified), it
  must be named, bounded, and excluded from conformance claims.

### Execution host mechanics

- **Collectible vs non-collectible**: collectible ALCs, verified by the spike
  (unload → `WeakReference` death). Script mode (`gsi <file>`, bare `gsc`)
  creates one ALC per run and the process exits anyway; collectibility
  matters for the interactive session and for test hosts running thousands of
  programs in-process.
- **Unloading across submissions**: submissions cannot unload individually —
  submission *N+1* references *N*'s assembly and *N*'s live state. The unit
  of unload is the **session** (one ALC), reclaimed on `Reset()` or exit.
  Memory therefore grows monotonically with submission count within a
  session, exactly as in Roslyn interactive; accepted and documented. A
  session that registers callbacks with default-ALC statics (timers, events)
  can pin the session ALC — accepted, same as any REPL.
- **Deinit semantics**: emitted code runs real deinitializers, so the
  GS0510 evaluator boundary in
  [ADR-0068](0068-deinit-destructor-support.md) disappears on migrated drivers;
  deinit behavior applies to all three file-mode columns uniformly.
- **stdout / exit code**: the host process's `Console` is the program's
  `Console` (today's gsi behavior, spike-verified including async
  submissions); the TUI's `CaptureConsole` redirection keeps working because
  `Console.SetOut` is process-global. Exit-code mapping keeps gsi's current
  contract (`int`/`uint` return, otherwise 0; diagnostics → rc 1).
- **In-process hazards** (unchanged from the evaluator, worth stating):
  `Environment.Exit` in user code terminates the driver — identical to
  Roslyn's csi; goroutines/threads spawned by a submission may keep running
  after it returns, as today.
- **Cancellation (Ctrl+C mid-run)**: parity with today, which is already
  best-effort — `SessionEngine.EvaluateAsync` documents that a running
  evaluation cannot be interrupted, only its result discarded. Emitted code
  is no worse: the submission runs on a background thread, cancel abandons
  the cell; a runaway submission leaks a thread exactly as it does now.
  A future hard-cancel could use `ControlledExecution.Run` or an
  out-of-process worker, but that is not a regression gate for this ADR.

### Interactive latency

Per-submission cost changes from "walk the trees" to "emit + JIT". Measured
in the spike (Debug build, Apple Silicon, xunit host): steady-state
emit+load+run of a small submission is **~47 ms** vs **~23 ms** for the
evaluator — both far below interactive perception thresholds, and Release
narrows the gap. First-submission warm-up (JIT of the emitter itself) is
~150–250 ms and can be hidden behind a background warm-up emit at REPL
startup. For compute-bound submissions the direction reverses decisively:
emitted code runs JIT-compiled IL (#2190's answer by construction).

Diagnostics, completions, hover, and the LSP are unaffected: the language
server binds and emits but never calls `Compilation.Evaluate` (verified by
grep — production consumers are only `src/Repl` and `src/Compiler`), and
REPL-side analysis (`AnalysisBridge`) is front-end only.

### What the conformance gate becomes

`SampleConformanceTests` currently runs three drivers and uses emit as the
oracle. Phase 1 flips two of the three columns to emitted execution, which
would make the gate mostly self-comparison **of codegen** — but not of hosts.
The gate's post-migration definition:

- **emit-to-file + `dotnet exec`** (out-of-process, the shipping `gsc /out:`
  product) remains the oracle;
- **emit-to-memory in-process** (the gsi/bare-gsc host) is compared against
  it cell-by-cell — this pins host mechanics rather than codegen: ALC
  resolution, `/r:` closure, Console/exit-code protocol, unhandled-exception
  shape, TFM/runtimeconfig differences between `dotnet exec` and in-proc
  loading;
- while any interpreter surface remains reachable before Phase 3c, the
  interpreter column stays in the gate for that surface, with the
  `ExpectedDifferences` table shrinking monotonically — entries are deleted
  with the boundary that caused them, never added.

After Phase 3 the gate is a two-column host-parity gate plus the golden
files, and the standing obligation to hand-maintain a table of known
divergence ends.

## Evidence — feasibility spike

`test/Interpreter.Tests/Adr0156EmitToMemorySpikeTests.cs` (trait
`Category=Adr0156Spike`, excluded from no gates, run via
`dotnet test test/Interpreter.Tests --filter "FullyQualifiedName~Adr0156"`)
proves the Phase 1 mechanic end-to-end with zero product changes:

- Compile three shipped samples (`Arithmetic.gs` — locals/functions/loops;
  `ArrowLambda.gs` — closures; `AsyncTask.gs` — async state machine) with the
  existing `Compilation.Emit(MemoryStream)`.
- Load the bytes in a collectible `AssemblyLoadContext` with a
  default-context `Resolving` fallback, invoke `Assembly.EntryPoint`
  in-process, capture stdout and the exit code.
- Compare against the sample's golden file **and** against
  `Compilation.Evaluate` output for the same source.

Results (Debug, .NET 10.0.9, Apple Silicon; all 4 tests green):

| Sample | Parse+bind | Emit to memory | PE bytes | ALC load+run | Evaluator run | Parity |
|---|---:|---:|---:|---:|---:|---|
| Arithmetic.gs | 22 ms | 26 ms | 2,560 | 0 ms | 21 ms | stdout == golden == evaluator; rc 0 |
| ArrowLambda.gs | 247 ms* | 146 ms* | 3,072 | 1 ms | 59 ms | stdout == golden == evaluator; rc 0 |
| AsyncTask.gs | 23 ms | 116 ms | 5,120 | 20 ms | 54 ms | stdout == golden == evaluator; rc 0 |

\* first test executed in the host; includes one-time JIT warm-up of the
front end / emitter.

Steady-state submission latency (5 iterations after warm-up, trivial
submission): emit+load+run **47.2 ms**, evaluator **23.2 ms**. The collectible
ALC was reclaimed (WeakReference died after unload) in every case. Framework
references resolved from the default context with no runtimeconfig and no
filesystem artifacts. **No Phase 1 blocker found**: stream emit exists, entry
points invoke, resolution works, unload works. The known open edge is the
reference channel for separately built assemblies (`Gsharp.Extensions`),
which is Phase 1 work by design (#3130), not a new gap.

## Consequences

- **The silent-divergence bug class ends by construction.** #3140-shaped
  bugs (rc 0, wrong value, no diagnostic) become impossible between drivers,
  because there is only one execution semantics left to disagree with itself.
- **The evaluator tax ends.** #3163 measured roughly half of recent fix
  commits paying interpreter parity costs; new language features stop
  needing a second implementation. ~7,300 lines of `Evaluator*.cs` plus
  `EvaluatorException` are ultimately deleted.
- **gsi gains capabilities for free**: deinit, P/Invoke, `fixed` /
  `stackalloc` / pointer storage, ByRefLike (#3114), the missing lambda
  shapes (#3003, #3050), reified generics with real members (#3099, #3137),
  a `/r:` channel (#3130), and JIT-speed execution (#2190).
- **ADR-0152 and ADR-0153 become transitional.** Their carefully drawn
  interpreter boundaries (GS0514, GS0513) and the deinit boundary (GS0510)
  are superseded per-driver as each driver migrates, and retire entirely at
  Phase 3. This ADR intentionally converts that boundary-drawing program
  from "formalize the interpreter's limits" into "remove the interpreter".
- **The conformance gate is redefined**, from three-engine divergence
  detection to two-host protocol parity plus goldens; the
  `ExpectedDifferences` table shrinks to empty instead of growing.
- **Costs**: Phase 2 is real compiler work (submission-as-metadata binding,
  variable hoisting, value echo) and carries the main schedule risk; session
  memory grows monotonically until `Reset()`; per-submission latency roughly
  doubles for trivial submissions (well under perception thresholds, and
  faster for anything compute-bound); in-process execution inherits
  `Environment.Exit` and runaway-thread hazards identical to today's
  evaluator and to Roslyn interactive.
- **Test migration is a long tail**: ~314 test files use
  `Compilation.Evaluate` as an oracle and migrate incrementally during
  Phase 3 under ADR-0154 witness discipline.

## Alternatives considered

### Status quo: keep the evaluator, keep fixing divergences, keep the parity gate

Rejected. The class regenerates faster than it is fixed — a dozen instances
in one month, several found only by out-of-band probing rather than the gate
— and each fix pays the double-implementation tax that #3163 measured at
~half of recent fix commits. The `ExpectedDifferences` table is a standing
admission that parity is aspirational. A gate can only detect divergence;
it cannot remove its cause.

### Re-derive the evaluator from the emit-path lowered trees

Run the full emit lowering pipeline (spiller, capture boxing, state
machines…) and interpret the *lowered* program, so both engines at least
consume identical trees. Rejected: it narrows the expression-level divergence
surface but keeps a second implementation of exactly the hardest parts —
CLR interop, reflection reification (#3099, #3137), the storage model
(ADR-0153), `Equals`/`GetHashCode` dispatch (#3116, #3134) — which is where
the worst bugs live. It also *adds* work (state-machine interpretation) for
no user-visible capability, and the parity gate burden remains forever.

### Hybrid end state: emit for scripts, evaluator for interactive

Phase 1 without Phases 2–3 as the destination. Rejected as an end state: it
retains the entire evaluator maintenance surface for the smallest driver
audience, and the interactive REPL — the tool a user reaches for to ask
"what does this expression do" — would remain the one place the answer can
be silently wrong. Kept only as the transitional posture between Phases 1
and 2, with the conformance gate still covering the interactive residue.

### Out-of-process execution: emit to a temp file and `dotnet exec` per run

What the conformance gate does. Rejected as the driver architecture:
process-start dominates (hundreds of ms per submission), interactive
submission chaining needs shared live state that cannot cross a process
boundary without a serialization protocol, and the REPL sidebar/value echo
would need a remoting layer. Retained as a fallback idea only for a future
hard-cancellation mode.
