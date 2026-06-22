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
| `corpus/` | The curated C# **input** corpus (L1–L3) plus xUnit oracles. Isolated from `GSharp.sln`; see [`corpus/README.md`](corpus/README.md). |

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
| `corpus/L2-Library` | PASS | FAIL (#940) | skip | skip |
| `corpus/L3-Library` | FAIL (#941–#944) | skip | skip | skip |

L1 migrates fully green end-to-end. L2 translates and compiles every construct
except overloaded static-method calls (#940). L3's `Advanced.cs` translates and
compiles standalone; `Generics.cs` surfaces four real parser/compiler gaps.

## Discovered compiler gaps (objective 2)

| Issue | Construct | Diagnostic |
| --- | --- | --- |
| [#938](https://github.com/DavidObando/gsharp/issues/938) | Owned-`struct` methods (receiver-clause warning) | GS0314 |
| [#939](https://github.com/DavidObando/gsharp/issues/939) | `for…in List[userType]` erases element type | GS0158 |
| [#940](https://github.com/DavidObando/gsharp/issues/940) | Static (`shared`) method overloads don't resolve by arity | GS0144 |
| [#941](https://github.com/DavidObando/gsharp/issues/941) | Binary `??` operator unsupported (only `??=` exists) | GS0005 |
| [#942](https://github.com/DavidObando/gsharp/issues/942) | `expr[i].Member` mis-parses `[i]` as type arguments | GS0005 |
| [#943](https://github.com/DavidObando/gsharp/issues/943) | Generic-interface constraint `[T IComparable[T]]` won't parse | GS0005 |
| [#944](https://github.com/DavidObando/gsharp/issues/944) | No user-indexer declaration form; attempts crash | GS9998 |

## Conventions

Non-test `cs2gs` projects enforce StyleCop + `TreatWarningsAsErrors`
(`AssemblyName` → `GSharp.<Project>`, `Nullable=disable`, `ImplicitUsings`):
copyright headers, XML docs on public members, SA1201 member ordering, SA1649
(filename = first type), and `this.` qualification are required. The solution
must build with **0 warnings / 0 errors**. The corpus and the local NuGet feeds
(`.nugs/`, `out/bin/Release/nupkgs/`) are kept clean and out of `GSharp.sln`.
