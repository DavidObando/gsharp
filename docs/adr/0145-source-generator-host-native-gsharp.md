# ADR-0145: Roslyn source-generator host for native G# projects (`gsgen`)

- **Status**: Accepted (implemented — build-time; see Implementation status)
- **Date**: 2026-07-06
- **Phase**: Phase 9 — ecosystem interop
- **Related**: ADR-0027 (no Roslyn in the compiler; Roslyn in sibling tools), ADR-0115 (cs2gs translator — reused core), ADR-0142 (resx generator — LS wiring precedent), ADR-0092 (`@LibraryImport`), ADR-0143 (cs2gs generator handling — companion), ADR-0144 (partial types — hard dependency), issues [#2201](https://github.com/DavidObando/gsharp/issues/2201)

## Context

A greenfield **native** G# project (`.gsproj`) that references a NuGet package
containing a Roslyn source generator must work as a C# developer would expect:
reference `CommunityToolkit.Mvvm`, annotate a field with `@ObservableProperty`,
and the generated property exists at build time and in the editor. ADR-0143
solves the **migration** direction (cs2gs runs the C# project's generators once
and freezes their output as translated G#); this ADR solves the **ongoing,
native** direction.

The obstacle is structural: Roslyn generators consume C# **syntax trees and
semantic models** and emit C# **source**, and ADR-0027 forbids Roslyn inside
gsc. ADR-0027 explicitly permits Roslyn in *sibling tools* (cs2gs is the
precedent), so the generators must run **outside** the compiler, against a C#
**projection** of the G# program, with their output translated back to G# and
fed to gsc as ordinary source.

Two facts make this tractable:

1. **Signature/body separation (verified).** `Compilation.GlobalScope` binds
   declaration signatures and attributes (`BoundAttribute` carries the resolved
   attribute type and constant arguments) **separately** from `BindProgram`,
   which binds bodies. So a C# stub carrying only declarations — the exact input
   an attribute-driven incremental generator
   (`ForAttributeWithMetadataName`) needs — can be projected from the bound
   global scope without binding any body. User bodies that reference
   not-yet-generated members produce diagnostics *in the global scope*, so the
   projection must consume the symbol tables and **ignore** non-fatal
   diagnostics.
2. **Reusable translation core.** `Cs2Gs.Translator.TranslateDocument` already
   takes an in-memory `LoadedDocument(path, SyntaxTree, SemanticModel)` with no
   MSBuildWorkspace dependency, and `Cs2Gs.CodeModel` already references
   `src/Core` across the tools/src boundary — so translating generated C# back
   to G# reuses existing, tested code.

The generated G# parts augment user types, which requires **ADR-0144 partial
types** — a hard dependency.

## Decision

Ship a Roslyn generator **host**, `gsgen`, in the G# SDK. It projects the G#
project to C# stubs, runs the project's real Roslyn generators against them,
translates the generated C# back to G# `partial` parts under `obj/gsgen/`, and
feeds them to gsc. The same host runs at build time (MSBuild target) and, as a
persistent sidecar, in the language server.

### A. A generator host outside gsc

A new library `GSharp.GeneratorHost` (`src/GeneratorHost/`) and console tool
`gsgen` (`gsgen @file.rsp` one-shot for builds; `gsgen serve` stdio JSON-RPC for
the LS). It is published into the SDK NuGet package under `tools/gsgen/`,
mirroring how the compiler ships under `tools/compiler/`. gsc stays Roslyn-free;
all Roslyn lives in `gsgen`.

### B. Stub projection from the bound global scope

`gsgen` parses and binds the project's `.gs` `@(Compile)` items to
`BoundGlobalScope` using the project's own `ReferenceResolver` (the same
references gsc receives), then renders one C# stub document per `.gs` file:

- **Namespaces** from packages; **types** by kind (`class`/`struct`/`interface`/
  `enum`/named delegate) with accessibility, base clause, and implemented
  interfaces.
- A type is emitted `partial` in the stub **iff the user declared it `partial`
  in G# (ADR-0144)** — deliberately, so a generator's "the type must be partial"
  diagnostic reaches the developer verbatim rather than being masked.
- **Member signatures** (methods, constructors, fields, properties, events,
  indexers, generics + constraints) with **bodies elided** (`=> throw null!`).
- **Attributes** on every symbol, spelled by **fully-qualified CLR metadata
  name** (`[global::CommunityToolkit.Mvvm.ComponentModel.ObservableProperty]`),
  positional/named constant arguments rendered from bound constant values —
  this is precisely what `ForAttributeWithMetadataName` matches on. Imported
  attribute types spell from `TypeSymbol.ClrType`; user-declared types spell
  from their package + name (a new `GsToCSharpTypeSpeller` — the reverse of
  cs2gs's `CSharpTypeMapper`, which does not exist yet).
- `#nullable enable` and `#line` directives mapping each declaration back to its
  `.gs` source, so generator diagnostics resolve to G# locations for free.

G#-only surface with no C# declaration equivalent projects to its **emitted CLR
shape** (`sequence[T]` → `IEnumerable<T>`, receiver-clause extensions → static
extension containers, top-level `func`s → members of the emitted module type). A
signature type that cannot be spelled (because it references a not-yet-generated
type — the single-pass boundary, §H) degrades to `object` with a `GS9204` info.

**Tolerance rule:** projection reads the global-scope symbol tables only, never
`BindProgram`; global-scope diagnostics (including unresolved references in
bodies and initializers) are ignored. Only parse-fatal input aborts, as
`GS9201`. Every stub must re-parse error-free before generator execution; a stub
that does not is a **host bug** (`GS9202`), never a user error.

### C. Shared translation core via a translator split

`Cs2Gs.Translator` is split: the MSBuildWorkspace/`Build.Locator`-dependent
`Loading/` moves to a new `Cs2Gs.ProjectLoading` project; the pure translator
(Roslyn `SyntaxTree` → `Cs2Gs.CodeModel`, no workspace dependency) stays and is
referenced by both `Cs2Gs.Pipeline` and `GSharp.GeneratorHost`. Back-translation
of each generated C# document reuses this core, including ADR-0143's
partial-member handling (elide unimplemented hooks; keep only implementing
parts). Generated documents translate to G# `partial` parts (ADR-0144).

### D. Generated output is G# `partial` parts under `obj/gsgen/`

One deterministic `.g.gs` per generated document, named
`{GeneratorAssembly}/{GeneratorType}/{hintName}.g.gs` (sanitized, ordered by
generator FQN then hint name). These are added to `@(Compile)` for gsc and
augment user types via ADR-0144 partials. They are written only when content
differs, so timestamps — and gsc's up-to-date check — do not churn.

### E. Analyzer resolution in the Gsharp SDK

**Verified gap:** `@(Analyzer)` is never populated for a Gsharp project. NuGet's
`ResolvePackageAssets` selects analyzer assets by `ProjectLanguage`, which the
SDK sets to `Gsharp`, so `analyzers/dotnet/cs` assets are skipped; and the
`analyzers/dotnet/roslynX.Y/cs` folder multiplexing that packages like
CommunityToolkit.Mvvm rely on is driven by `$(CompilerApiVersion)`, set only by
`Microsoft.Managed.Core.targets`, which a Gsharp project never imports. Two new
SDK pieces fill the gap:

- `_GsharpResolveAnalyzers` re-invokes the SDK's own `ResolvePackageAssets` with
  `ProjectLanguage="C#"` and `CompilerApiVersion="$(GsharpCompilerApiVersion)"`
  (pinned in props to gsgen's embedded Roslyn, e.g. `roslyn4.14`) against a
  **distinct** assets-cache file, capturing its `Analyzers` output into
  `@(GsharpAnalyzer)` (unioned with user `@(Analyzer)` and ProjectReference
  analyzers). This reuses battle-tested SDK code for both asset selection and
  the `roslynX.Y` multiplexing.
- `_GsharpGenerateAnalyzerConfig` replicates the SDK's
  `GenerateMSBuildEditorConfigFile`: an `is_global` editorconfig of
  `build_property.X = value` from `@(CompilerVisibleProperty)`, seeded with the
  standard set (`RootNamespace`, `ProjectDir`, `TargetFramework`, …). Packages'
  own `CompilerVisibleProperty` items (MVVM feature switches) flow automatically.

### F. Build wiring

`_GsharpRunSourceGenerators` (`BeforeTargets="CoreCompile"`, skipped when
`@(GsharpAnalyzer)` is empty — zero cost for the currently universal
no-generator project) runs a new `GsgenTask` modeled on the existing `BuildTask`:
it writes a `.gsgen.rsp` (`/gs:`, `/analyzer:`, `/r:`, `/additionalfile:`,
`/analyzerconfig:`, `/out:`, `/rootnamespace:`) and launches `dotnet
tools/gsgen/gsgen.dll @rsp`, relaying `gsgen`'s structured diagnostic lines
through the MSBuild logger via the same regex convention `BuildTask` uses. A
stamp manifest lists every written `.g.gs`; the target's `Inputs`/`Outputs` plus
the `CoreCompileInputs.cache` idiom give correct incrementality, and `gsgen`
deletes orphaned outputs from the previous stamp. The generated files are
injected into `@(Compile)`, which `CoreCompile` picks up because target inputs
evaluate at execution time.

**Process model — separate console tool, not an in-proc MSBuild task.** The task
assembly is `netstandard2.0` and runs inside MSBuild, where a second
version-pinned `Microsoft.CodeAnalysis` cannot safely coexist with MSBuild's own
copy, and controllable `AssemblyLoadContext`s for generator isolation are
unavailable. A separate process gives crash isolation (a hostile generator kills
only `gsgen`, surfaced as `GS9200`), matches how gsc itself runs, and shares one
binary with the LS.

### G. Language-server integration — a persistent `gsgen serve` sidecar

The LS spawns `gsgen serve` lazily per workspace (out-of-proc, chosen over
in-proc so the LS stays Roslyn-free, memory-capped, and crash-isolated). It
discovers analyzers/additional-files/config by polling the `.gsgen.rsp` next to
the existing gsc-rsp polling (`ProjectState.ReferenceSourcePath` pattern). On a
`.gs` `didChange`, `ProjectState` marks generated docs dirty and the sidecar
client schedules a **debounced (~500 ms trailing)** regeneration from the
in-memory buffers; on completion it swaps the generated-tree layer into the
project compilation, invalidates, and fires the existing diagnostic-refresh.
Completion, hover, and go-to-definition see generated members because the
generated trees are ordinary members of the compilation; the files are also
written to `obj/gsgen/` so navigation targets exist on disk (the resx
`HandleResxFileChange` precedent). Staleness is **last-good-wins** (matching
Roslyn IDE behavior); a failed run keeps the previous output and never degrades
user-code diagnostics. The sidecar restarts with backoff; three strikes disable
generators for the session with a status notification.

### H. Single-pass semantics and the fidelity boundary

Generators see only user declarations (as stubs) — never each other's output,
exactly as in csc. Generated G# augments user types via ADR-0144 partials; user
**bodies** referencing generated members bind only in gsc's final compile. The
one divergence from csc: a user **signature** referencing a generated *type*
degrades in the stub (§B) and may reduce what attribute-driven generators match
— documented via `GS9204`.

- **Works (v1 contract):** attribute-driven, declaration-based incremental
  generators — CommunityToolkit.Mvvm, System.Text.Json source generation,
  `GeneratedRegex`, `LibraryImport` (complementing ADR-0092), strongly-typed-ID
  and mapper generators. This is the dominant modern pattern.
- **Degraded / unsupported:** generators inspecting method **bodies** or
  C#-syntax trivia (stubs have no bodies), generators keying on C#-only syntax
  shapes, interceptors and other csc-only hooks, VB generators.
- **Discoverability:** `gsgen` emits a per-build summary (generators discovered,
  run, skipped, crashed, documents produced), plus `GS9206` info when a
  generator produced zero output while its triggering attribute appears in user
  code, and `GS9207` per-document back-translation gaps (reusing cs2gs triage
  records). Host/generator failures use `GS9200`–`GS9219` (verified free):
  `GS9200` non-structured exit, `GS9201` parse-fatal input, `GS9202` stub
  re-parse failure (host bug), `GS9203` generator threw, `GS9204` unspellable
  signature type, `GS9205` analyzer load failure, `GS9206` generator matched
  nothing, `GS9207` back-translation gap.

### I. Determinism contract

Stub rendering, hint-name mapping, and translation are pure functions of the
bound scope; outputs are byte-identical run to run and written only when
changed. In `serve` mode the `GeneratorDriver` is retained between runs so
Roslyn's incremental caching applies when per-file stub trees are unchanged
(stubs are rendered per file to preserve this).

## Implementation status

Delivered (build-time path proven end-to-end with a real `dotnet build` — a
`.gsproj` referencing CommunityToolkit.Mvvm resolves the generator, runs it, and
gsc consumes the emitted `.g.gs`):

- **Engine** — `tools/gsgen/GSharp.GeneratorHost`: `GsToCSharpTypeSpeller` +
  `GsStubRenderer`/`GsToCSharpProjection` (§B), `GeneratorRunner` driving
  `CSharpGeneratorDriver` with crash isolation and an `AnalyzerFileReference`
  loader (§H), `GeneratedDocTranslator` back-translation, and the
  `GeneratorHostRunner` facade. The reused translator gained a
  `preservePartialParts` mode so each generated part becomes a standalone G#
  `partial` part, plus partial-**method** elision (ADR-0143 §D) for hook methods
  G# cannot express.
- **`gsgen` CLI** (§A) — `tools/gsgen/Gsgen.Cli` (`gsgen @file.rsp`), diagnostics
  in gsc's line format.
- **SDK wiring** (§E/§F) — `GsgenTask`, `_GsharpResolveAnalyzers` (the
  `ResolvePackageAssets` re-invocation with `ProjectLanguage=C#` +
  `$(GsharpCompilerApiVersion)` — the fix that makes a `.gsproj`'s generators
  resolve at all), `_GsharpRunSourceGenerators` before `CoreCompile`, and
  `PackGsgen` packaging under `tools/gsgen/`.
- **Translator split** (§C) — `Cs2Gs.ProjectLoading` extracted so the shipped
  tool doesn't carry MSBuildWorkspace/Build.Locator.
- **Language server** (§G, partial) — generated `obj/**/gsgen/*.g.gs` are
  surfaced to the LS compilation and watched, so generated members resolve in the
  editor after a build.

Follow-ups (not in the initial delivery):

- **Back-translation fidelity for CommunityToolkit.Mvvm** — its generated code
  currently trips genuine cs2gs/gsc gaps, filed as: gsc static access through a
  fully-qualified generic type (`GS0157`,
  [#2209](https://github.com/DavidObando/gsharp/issues/2209)); gsc unqualified
  call to a method inherited from an imported base (`GS0130`,
  [#2210](https://github.com/DavidObando/gsharp/issues/2210)); cs2gs
  back-translation emitting short type/enum names without imports
  (`GS0113`/`GS0157`/`GS0202`,
  [#2211](https://github.com/DavidObando/gsharp/issues/2211)). These are the §H
  fidelity boundary; generators whose output gsc can already compile (verified
  via the host's end-to-end test) work fully.
- **Live in-editor regeneration** — the out-of-proc `gsgen serve` sidecar that
  re-runs generators on keystroke (§G). The delivered LS slice covers post-build
  visibility; `serve` mode is deferred.

## Consequences

- Positive: native `.gsproj` projects get the C# generator experience — build
  and editor — for the dominant attribute-driven generator category, with no
  per-generator code.
- Positive: one host binary backs both builds and the LS, so their behavior is
  definitionally identical, and it reuses the cs2gs translator and ADR-0143
  partial-member rules rather than duplicating them.
- Neutral: generated output lives under `obj/gsgen/` (gitignored by convention),
  navigable but not user-edited.
- Negative: the SDK gains a second `ResolvePackageAssets` invocation with a
  divergent `ProjectLanguage` — unconventional and exposed to SDK-version drift;
  it must be e2e-covered on every SDK bump. `gsgen`'s pinned Roslyn version
  bounds which generator packages can load (`GS9205`).
- Negative: LS regeneration rebuilds the stub compilation per debounced edit;
  large projects may need save-only triggering if per-keystroke is too hot.
- Constraint: depends on ADR-0144 partial types (generated parts augment user
  types) and ADR-0143 (shared partial-member handling); the e2e fixture cannot
  land until both do.

## Scope limitation (explicitly out of scope)

Generators inspecting method bodies, C#-syntax shapes, or csc-only hooks
(interceptors) are not supported — the stub carries declarations only. This is a
deliberate boundary, surfaced to developers via the per-build summary and
`GS9206`/`GS9207`, not a silent degradation.

## Alternatives considered

- **In-proc MSBuild task hosting Roslyn.** Rejected: cannot safely load a
  second pinned `Microsoft.CodeAnalysis` beside MSBuild's, lacks controllable
  ALCs on netstandard2.0, and a generator crash would take down the build node.
- **Bespoke `project.assets.json` analyzer walker.** Rejected in favor of
  re-invoking the SDK's `ResolvePackageAssets`: more code, and it would drift
  from NuGet's asset-selection and `roslynX.Y`-multiplexing semantics.
- **In-proc LS generator hosting.** Rejected: adds Roslyn + the translator to
  the LS working set (fighting ADR-0107 cold-start goals) and couples a
  generator crash to every LS feature. The out-of-proc sidecar is restartable
  and memory-capped.
- **Teach gsc to run generators directly.** Rejected: violates ADR-0027's "no
  Roslyn in the compiler" boundary outright.
- **Compile a C# shadow assembly and reference it.** Rejected for
  member-augmenting generators: MVVM's generated members belong *on the user's
  types*, which a separate metadata assembly cannot provide — the same reason
  ADR-0143 translates rather than referencing metadata.
