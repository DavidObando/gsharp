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

## Install as a .NET tool

`cs2gs` ships as the `Gsharp.Cs2Gs` package (exposes the `cs2gs` command). A
.NET 10 runtime is required.

```sh
dotnet tool install --global Gsharp.Cs2Gs
cs2gs migrate --help
```

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

### ILVerify exception policy

Stage 3 does not treat green CI or an application that happens to run as proof
that invalid non-unsafe IL is acceptable. An exception is method- and
diagnostic-scoped and requires a matching C#-built baseline. Issue #2671 adds
one such upstream exception for Avalonia 11.2.7 XamlIl-generated
`XamlClosure_N::Build_N(IServiceProvider)` methods. The filter requires all of:

- `StackUnexpected`;
- the exact generated closure/method/signature convention; and
- XamlIl's exact object-slot mismatch, `found ref 'object'` to an expected
  reference type.

Other errors in the same assembly and other errors in a matching method remain
gating failures.

The proof used Oahu commit
`200e3b4c26c781368f74bbef098caea89bac8754` and its C# release artifact
`8365085850`. Both the original C# build and migrated G# build contain these
six identical diagnostics (paths normalized), hash
`d467dfc517fa448a1cff59f934afc11bbcebf5901910629db36ad63e8264bf50`:

| Method | Offsets | Triage fingerprint |
| --- | --- | --- |
| `BookLibraryView+XamlClosure_1::Build_1` | `0x1B`, `0x20`, `0xB1` | `sha256:9d0322446fc5a1cc4b78e2a66d5d83354b6e527fcd49d9f907fe63ccbb034a53` |
| `ConversionView+XamlClosure_2::Build_1` | `0x1B`, `0x20`, `0xD7` | `sha256:94a053bb50ec2721c8600fe77dd02aa29a401f95bf174b39b459218f5dfea5a7` |

Token-resolved ILSpy method disassemblies are identical after removing only
the RVA comment: BookLibrary
`d79a21c01d54baa12c9c7f689d1beba1b1dcd814160cfecf7048100f3f90cae4`;
Conversion
`66d3ea09ffba550e5d034135c085d9010c9ee85a6e003a2417132697e25ceeba`.
The raw IL streams have the same sizes/maxstack (183/9 and 221/9) but different
hashes because metadata row tokens differ between csc and gsc assemblies:

| Method | Original raw IL SHA-256 | Migrated raw IL SHA-256 |
| --- | --- | --- |
| BookLibrary `Build_1` | `9af2771d7ae3e81889e17959afe409fc31bd8bbb33a827ddc156e6ffd43bbfdc` | `91db5378181a2bbcc720ad9d5018034cb960df3ef04cf827b73aba885d05b679` |
| Conversion `Build_1` | `ef14249dfeb99e2455b14a06459735e5312fdfad05402724c69185234ffe6e1d` | `d81df7df85024b9ff4c5e5dd36fc3303d541687e75abcc57ba8917a0b723bfa7` |

Ownership is also observable before verification. Neither compiler's
`obj/Release/net10.0/Oahu.UI.dll` contains `XamlClosure` types. Avalonia's
`CompileAvaloniaXamlTask` writes
`obj/Release/net10.0/Avalonia/Oahu.UI.dll`; only that post-processed assembly
contains them, and it is byte-identical to the copied `bin` assembly. The
original pre/post hashes are `0f0d5e80…`/`f26eeb88…`; the migrated hashes are
`86f7e159…`/`f534dc90…`. The relevant checks are:

```sh
sha256sum obj/Release/net10.0/{,Avalonia/}Oahu.UI.dll \
  bin/Release/net10.0/Oahu.UI.dll
ilspycmd -l c obj/Release/net10.0/Oahu.UI.dll | grep XamlClosure
ilspycmd -l c obj/Release/net10.0/Avalonia/Oahu.UI.dll | grep XamlClosure
ilverify bin/Release/net10.0/Oahu.UI.dll -s System.Private.CoreLib <reference flags>
ilspycmd -il bin/Release/net10.0/Oahu.UI.dll > proof.il
```

Invoking both exact methods from each assembly returns `TextBlock` and
`ProgressBar`, respectively. This establishes an upstream, runtime-valid
verifier exception; it does not excuse unrelated Avalonia or gsc diagnostics.
Applying the narrowed filter to either complete nine-error Oahu log leaves the
same `AboutView.!XamlIlPopulate` `DelegateCtor` error gating. That separate
diagnostic remains unsuppressed and is tracked by #2672.

## Construct coverage (ADR-0138)

The authoritative statement of C# 14 coverage is
[`coverage/csharp-construct-inventory.json`](coverage/csharp-construct-inventory.json):
one row per Roslyn node `SyntaxKind` with a status of `Translated`, `Lowered`,
`UnsupportedByDesign` (+rationale), `Gap` (+issue), or `Unclassified` (capped
by a never-raise ratchet). The human-readable rollup is generated into
[`docs/cs2gs-coverage-matrix.md`](../../docs/cs2gs-coverage-matrix.md).

- `cs2gs coverage` — report drift (exit 1) between the inventory, the
  Roslyn-surface golden, and the docs matrix.
- `cs2gs coverage --write` — after a Roslyn bump: append `Unclassified`
  skeleton rows for new kinds, canonicalize, regenerate golden + docs.

`ConstructInventoryGoldenTests` enforces all of it in CI; the
`UnsupportedByDesign` registry (consulted by every translator rejection)
must stay equal to the inventory's unsupported rows
(`TranslatorExhaustivenessTests`), so an accidental fallthrough is minted
`CS2GS-GAP` instead of hiding behind `CS2GS-UNSUPPORTED`.

The `corpus/grid/G01…G14` apps are the per-construct differential fixtures:
one construct per `Constructs/<SyntaxKind>.cs`, executable, stdout
byte-compared C#-vs-G# in stage 4.

## Triage workflow & CI gate (ADR-0138)

The checked-in gap ledger [`triage/gaps.json`](triage/gaps.json) is both the
fingerprint↔issue map and the CI baseline:

```sh
# classify a run against the ledger (read-only)
cs2gs triage list --run cs2gs-runs/<runId>

# file issues for NEW fingerprints (dry-run by default; --file creates them,
# clustered by root cause, capped via --limit)
cs2gs triage file-issues --run cs2gs-runs/<runId> --file

# reconcile ledger statuses with GitHub (closed issue -> resolved; requires an
# Issue<N>* regression test or --no-test-reason)
cs2gs triage sync --write
```

`cs2gs migrate --baseline tools/cs2gs/triage/gaps.json` gates on the ledger:
**NEW** or **REGRESSED** fingerprints fail; **KNOWN** open gaps are tolerated;
**STALE** entries warn (fail with `--baseline-strict`, the nightly mode); an
**unverified** app (skipped stage, no artifact) must be acknowledged in the
ledger's `unverifiedApps`. The `cs2gs` job in `.github/workflows/build.yml`
runs this on every PR; `.github/workflows/cs2gs-nightly.yml` runs strict mode
and auto-files issues for new gaps, opening a ledger-update PR.

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
| `corpus/L3-Library` | PASS | PASS | PASS | skip (unverified, ledgered; [#1924](https://github.com/DavidObando/gsharp/issues/1924)) |
| `corpus/L4-Console` | PASS | PASS | PASS | PASS |
| `corpus/L5-Console` | PASS | PASS | PASS | PASS |
| `corpus/grid/G01…G14` (14 apps) | PASS except deliberate G07 unsupported operator | PASS | PASS | PASS |
| `corpus/CompileGap-Library` | PASS | FAIL (deliberate, ledgered wontfix) | skip | skip |

With `--baseline tools/cs2gs/triage/gaps.json` the run above gates green
(`2 known, 0 new, 0 regressed, 0 stale`): every residual failure is a
ledgered, issue-linked gap. The grid build-out filed the coverage backlog as
issues [#1879–#1934](https://github.com/DavidObando/gsharp/issues?q=label%3A%22gap%3Atranslate%22%2C%22gap%3Acompile%22%2C%22gap%3Ailverify%22%2C%22gap%3Aparity%22)
(37 translator gaps, 17 gsc gaps, 1 pipeline policy), each with a quarantined
fixture next to its grid app.

L1, L2, L4, and L5 migrate fully green end-to-end. L2 went green when #973/#974 were
fixed. L4 emits the **canonical** forms for an interpolated `: base(...)` argument,
a `struct` interface clause, and an inline BCL `out var x` now that #975/#976/#977
are fixed. L3 translates in full but is blocked at **compile** by a residual gap
(#985: `IEnumerable[T]` needs two `GetEnumerator` overloads differing only by
return type — GS0264 + GS0187). L3's `Advanced.cs` translates and compiles
standalone. L5 (inheritance/polymorphism, `is`/`switch` pattern matching, a
`yield return` iterator → `sequence[T]`, generic constraints) reaches **full
parity** by using only the canonical/compiling forms, and surfaces the next batch
of gaps (#986…#994) — captured as verified triage records (the constructs with
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
| #985 | Implementing `IEnumerable[T]` needs two `GetEnumerator` overloads differing only by return type | GS0264 + GS0187 | open (blocks L3-`Generics`) |
| #986 | `base.Method()` virtual base-class call has no canonical G# form | GS0157 / GS0338 | open (translation-unsupported) |
| #987 | An `abstract` (no-body) method on an `open class` crashes the emitter | GS9998 (NRE) | open |
| #988 | `new T()` construction under a `new()` constraint has no canonical G# form | GS0125 / GS0130 / GS0157 | open (translation-unsupported) |
| #989 | A generic auto-property over `T` (`prop Value T`) cannot be member-accessed | GS0158 | resolved (construction substitutes the property table like fields) |
| #990 | A user reference-type iterator (`sequence[UserClass]`) crashes the emitter | GS9998 | resolved (user reference- and value-type element iterators emit, ilverify, and run) |
| #991 | A `when` guard on a `switch` arm won't parse | GS0005 | open (translation-unsupported) |
| #992 | `and`/`or` binary patterns (`> 0 and < 10`) won't parse | GS0005 | open (translation-unsupported) |
| #993 | An `is`/`case` type pattern **with** a binder (`x is T t`) leaves the binder unbound | GS0125 | open |
| #994 | `yield break` has no canonical G# form | GS0005 | open (translation-unsupported) |

Gaps #975/#976/#977 — discovered by L4 — are now **resolved**, so the translator
emits the canonical forms directly: the interpolated `: base("…$n…")` argument, the
`struct Money(Cents int32) : IEquatable[Money]` interface clause, and the inline
BCL `out var x`. The residual L3 gap and the L5 batch (#986…#994) are each a
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
