# cs2gs — C#→G# migration tool & gap-discovery pipeline

`cs2gs` translates idiomatic C# into **canonical G#**, then drives the result
through a four-stage verification pipeline and produces distributable
HTML + JSON reports. It serves **two objectives** (issue #914):

1. **Migrate** real C# applications to faithful, canonical G# (Roslyn-based
   front end → G# code model → printer).
2. **Discover G# compiler gaps** — every construct that fails to translate,
   compile, IL-verify, or reach test parity is captured as a structured,
   deduplicated triage record that can be filed as a compiler issue.

The full design contract lives in
[`docs/adr/0115-csharp-to-gsharp-migration-tool.md`](../../docs/adr/0115-csharp-to-gsharp-migration-tool.md)
(§B canonical translation rules, §C pipeline, §D triage schema, §E corpus &
oracle, §F reporting). This README is the operational quick start.

## Architecture

| Project | Responsibility |
| --- | --- |
| `Cs2Gs.CodeModel` | The G# code model (AST under `Ast/`) and the canonical `GSharpPrinter` (golden-tested), independent of Roslyn. |
| `Cs2Gs.Translator` | Roslyn C# front end. `CSharpToGSharpTranslator` + `CSharpTypeMapper` map C# syntax/semantics to the code model (the only project that references `Microsoft.CodeAnalysis.CSharp`). |
| `Cs2Gs.Pipeline` | The four ordered, short-circuiting migration stages, the triage builder + fingerprint, corpus discovery, and the `gsc` invoker. |
| `Cs2Gs.Report` | Aggregates a run into a self-contained `report.html` + `summary.json`. |
| `Cs2Gs.Cli` | The `cs2gs` command-line front end (`migrate` / `report` verbs). |
| `Cs2Gs.Tests` | Unit + golden + live tests for all of the above. |
| `corpus/` | The curated C# **input** corpus (L1–L5) plus xUnit oracles. Isolated from `GSharp.sln`; see [`corpus/README.md`](corpus/README.md). |

Why Roslyn here does not contradict ADR-0027 (no Roslyn *in the compiler*):
`cs2gs` uses Roslyn as an **external, offline C# reader** in a separate process;
`gsc` gains no Roslyn dependency. See ADR-0115 §A.

## Build

```sh
dotnet build GSharp.sln -c Release -graph --no-restore
```

This builds the compiler (`gsc`) and all `cs2gs` projects. Produced assemblies:

- CLI: `out/bin/Release/Cs2Gs.Cli/cs2gs.dll` (AssemblyName `cs2gs`)
- Compiler: `out/bin/Release/Compiler/gsc.dll` (AssemblyName `gsc`)

IL verification (stage 3) uses the repo's local `ilverify` tool — restore it
once with `dotnet tool restore` at the repo root.

## Run

### `migrate` — translate + verify the corpus

```sh
dotnet out/bin/Release/Cs2Gs.Cli/cs2gs.dll migrate \
  --corpus tools/cs2gs/corpus \
  --out /tmp/cs2gs-run \
  --config Release
```

| Option | Meaning |
| --- | --- |
| `--corpus <dir>` | Corpus root (default `tools/cs2gs/corpus`). |
| `--app <id>` | Migrate only this app (repeatable), e.g. `--app corpus/L1-Console`. |
| `--gsc <path>` | Override `gsc.dll` (default `out/bin/<Config>/Compiler/gsc.dll`). |
| `--out <dir>` | Runs root for artifacts (default `./cs2gs-runs`). |
| `--config <name>` | Build config used to locate `gsc` (default `Release`). |

Each run prints a per-app × per-stage status matrix and writes a timestamped
run directory containing the generated `.gs`, triage records, `run.json`, and an
auto-generated `report.html` + `summary.json`. The process exit code is
non-zero if any app fails a stage, so CI can gate on it.

### `report` — regenerate a report from an existing run

```sh
dotnet out/bin/Release/Cs2Gs.Cli/cs2gs.dll report --run /tmp/cs2gs-run/<runId>
```

`--out <dir>` overrides the output location (defaults to the run dir).

## The four-stage pipeline (ADR-0115 §C)

Stages run in order and short-circuit: a failure stops that app and records a
triage artifact; later stages are reported as `skip`.

1. **Translate** — C#→G# via Roslyn; round-trips the printed G# back through the
   parser. Failures → category `translation-unsupported`.
2. **Compile** — invokes `gsc` (`/target:exe|library /out: /reference:`).
   Failures → `compile-error`.
3. **IlVerify** — runs `ilverify` over the emitted assembly (ports the repo's
   `IlVerifier` recipe, with two cited false-positive ignore bundles).
   Failures → `ilverify-failure`.
4. **TestParity** — for executables, byte-compares stdout against the captured
   C# baseline; for libraries, builds a G# xUnit test project (local
   `Gsharp.NET.Sdk`) and compares the passing/failing test set against the C#
   xUnit oracle. Failures → `test-parity-failure`.

## Triage & fingerprinting (ADR-0115 §D)

Every gap is written as a JSON triage artifact with a stable **fingerprint**:

```
fingerprint = sha256(category | stage | diagnostic.id | construct.kind | normalizedShape)
```

The fingerprint deliberately **excludes** `runId`, `appId`, and source positions
so the *same* gap deduplicates across apps and runs. The report groups
occurrences by fingerprint, so one compiler gap surfaced by three apps shows as a
single entry with three occurrences.

## Reports (ADR-0115 §F)

- `report.html` — a single self-contained file (no external CSS/JS/network
  references), deterministic, HTML-encoded; the per-app matrix plus gaps grouped
  by fingerprint.
- `summary.json` — the machine-readable aggregate (`run.json` + triage records).

## Corpus & how to add an app

The corpus (`corpus/`) is ordinary, idiomatic C# — the migration **input** — and
is intentionally ordered by increasing complexity (L1 simplest first) so the
smallest possible gap is isolated first. It is **isolated** from `GSharp.sln`
(its own self-contained `Directory.Build.props`), so changing it does not affect
the product build. To add an app:

1. Add a C# project under `corpus/<Level>-<Name>/`.
2. For executables, capture the stdout baseline; for libraries, capture the
   xUnit oracle into `<App>.Tests/baseline.tests.json` (see
   `corpus/capture-baselines.sh` / `corpus/trx-to-baseline.py`).
3. Re-run `migrate` to translate and verify it.

See [`corpus/README.md`](corpus/README.md) for the level matrix and oracle
details.

## Current migration matrix

| App | translate | compile | ilverify | test-parity |
| --- | --- | --- | --- | --- |
| `corpus/L1-Console` | PASS | PASS | PASS | PASS |
| `corpus/L2-Library` | PASS | PASS | PASS | PASS |
| `corpus/L3-Library` | PASS | FAIL (#TBD-1) | skip | skip |
| `corpus/L4-Console` | PASS | PASS | PASS | PASS |
| `corpus/L5-Console` | PASS | PASS | PASS | PASS |

L1, L2, L4, and L5 migrate fully green end-to-end. L2 went green when #973/#974 were
fixed. L4 emits the **canonical** forms for an interpolated `: base(...)` argument,
a `struct` interface clause, and an inline BCL `out var x` now that #975/#976/#977
are fixed. L3 translates in full but is blocked at **compile** by a residual gap
(#TBD-1: `IEnumerable[T]` needs two `GetEnumerator` overloads differing only by
return type — GS0264 + GS0187). L3's `Advanced.cs` translates and compiles
standalone. L5 (inheritance/polymorphism, `is`/`switch` pattern matching, a
`yield return` iterator → `sequence[T]`, generic constraints) reaches **full
parity** by using only the canonical/compiling forms, and surfaces the next batch
of gaps (#TBD-2…#TBD-10) — captured as verified triage records (the constructs with
no canonical form, or that ICE/mis-compile, are held out of L5). As gaps are fixed
the frontier advances automatically — #938–#944 moved L3 to `translate PASS`, and
#973–#977 took L2 green and let L4 use the canonical forms.

## Discovered compiler gaps (objective 2)

| Issue | Construct | Diagnostic | Status |
| --- | --- | --- | --- |
| [#938](https://github.com/DavidObando/gsharp/issues/938) | Owned-`struct` methods (receiver-clause warning) | GS0314 | resolved |
| [#939](https://github.com/DavidObando/gsharp/issues/939) | `for…in List[userType]` erases element type | GS0158 | resolved |
| [#940](https://github.com/DavidObando/gsharp/issues/940) | Static (`shared`) method overloads don't resolve by arity | GS0144 | resolved |
| [#941](https://github.com/DavidObando/gsharp/issues/941) | Binary `??` operator unsupported (only `??=` existed) | GS0005 | resolved |
| [#942](https://github.com/DavidObando/gsharp/issues/942) | `expr[i].Member` mis-parses `[i]` as type arguments | GS0005 | resolved |
| [#943](https://github.com/DavidObando/gsharp/issues/943) | Generic-interface constraint `[T IComparable[T]]` won't parse | GS0005 | resolved |
| [#944](https://github.com/DavidObando/gsharp/issues/944) | No user-indexer declaration form; attempts crash | GS9998 | resolved |
| [#973](https://github.com/DavidObando/gsharp/issues/973) | A `class` with a user `struct`/`data struct` field — emit ICE | GS9998 | resolved (L2 green) |
| [#974](https://github.com/DavidObando/gsharp/issues/974) | Generic-interface impl: method returning a constructed generic over `T` (e.g. `IEnumerator[T]`) fails satisfaction | GS0187 | resolved |
| [#975](https://github.com/DavidObando/gsharp/issues/975) | Interpolated string in a `: base(...)` constructor-arg position — emit ICE | GS9998 | resolved (emitted directly) |
| [#976](https://github.com/DavidObando/gsharp/issues/976) | A `struct` cannot declare a base / interface clause (`struct S : I {…}`) | GS0005 | resolved (interface clause parses; class base → GS0382) |
| [#977](https://github.com/DavidObando/gsharp/issues/977) | BCL method with an inline `out var x` declaration fails overload resolution | GS0159 | resolved (inline `out var` binds) |
| #TBD-1 | Implementing `IEnumerable[T]` needs two `GetEnumerator` overloads differing only by return type | GS0264 + GS0187 | open (blocks L3-`Generics`) |
| #TBD-2 | `base.Method()` virtual base-class call has no canonical G# form | GS0157 / GS0338 | open (translation-unsupported) |
| #TBD-3 | An `abstract` (no-body) method on an `open class` crashes the emitter | GS9998 (NRE) | open |
| #TBD-4 | `new T()` construction under a `new()` constraint has no canonical G# form | GS0125 / GS0130 / GS0157 | open (translation-unsupported) |
| #TBD-5 | A generic auto-property over `T` (`prop Value T`) cannot be member-accessed | GS0158 | open |
| #TBD-6 | A user reference-type iterator (`sequence[UserClass]`) crashes the emitter | GS9998 | open |
| #TBD-7 | A `when` guard on a `switch` arm won't parse | GS0005 | open (translation-unsupported) |
| #TBD-8 | `and`/`or` binary patterns (`> 0 and < 10`) won't parse | GS0005 | open (translation-unsupported) |
| #TBD-9 | An `is`/`case` type pattern **with** a binder (`x is T t`) leaves the binder unbound | GS0125 | open |
| #TBD-10 | `yield break` has no canonical G# form | GS0005 | open (translation-unsupported) |

Gaps #975/#976/#977 — discovered by L4 — are now **resolved**, so the translator
emits the canonical forms directly: the interpolated `: base("…$n…")` argument, the
`struct Money(Cents int32) : IEquatable[Money]` interface clause, and the inline
BCL `out var x`. The residual L3 gap and the L5 batch (#TBD-2…#TBD-10) are each a
verified minimal repro (with a contrasting passing control) documented in
ADR-0115 §G for the compiler backlog. L5 also drove two **translator faithfulness
fixes** (no compiler change): an `int` literal implicitly promoted to a `double`
parameter is emitted as a float literal (avoiding an `ilverify` `StackUnexpected`),
and a parameterless constructor that initializes a **property** keeps its explicit
`init()` body (G# has no property member initializer).

## Conventions

Non-test `cs2gs` projects enforce StyleCop + `TreatWarningsAsErrors`
(`AssemblyName` → `GSharp.<Project>`, `Nullable=disable`, `ImplicitUsings`):
copyright headers, XML docs on public members, SA1201 member ordering, SA1649
(filename = first type), and `this.` qualification are required. The solution
must build with **0 warnings / 0 errors**. The corpus and the local NuGet feeds
(`.nugs/`, `out/bin/Release/nupkgs/`) are kept clean and out of `GSharp.sln`.
