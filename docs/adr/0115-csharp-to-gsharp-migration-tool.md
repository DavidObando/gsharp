# ADR-0115: `cs2gs` — a C#→G# migration tool and gap-discovery pipeline

- **Status**: Accepted
- **Date**: 2026-06-21
- **Phase**: Tooling — issue #914
- **Related**: issue [#914](https://github.com/DavidObando/gsharp/issues/914) (C#→G# migration tool), [ADR-0027](0027-roslyn-fork-decision.md) (Roslyn-fork decision); canonical-output rules cite ADR-0008, ADR-0014, ADR-0017, ADR-0019, ADR-0020, ADR-0024, ADR-0025, ADR-0029, ADR-0047, ADR-0049, ADR-0051, ADR-0053, ADR-0055, ADR-0065, ADR-0067, ADR-0075, ADR-0078, ADR-0079, ADR-0097, ADR-0098, ADR-0109; `website/docs/ref/spec.md`.

## Context

G#'s surface syntax has matured (Phases 1–7; ADR-0001 through ADR-0114) to the point where idiomatic C# maps onto canonical G# in a largely mechanical way: C# `class`/`struct`/`record`/`record struct` correspond to G# `class`/`struct`/`data class`/`data struct`; C# generics map to bracketed G# generics (ADR-0020); C# delegates map to arrow function types (ADR-0075); C# attributes map to `@`-annotations (ADR-0047). Issue #914 asks for a tool that exploits this to do two things at once:

1. **Transform existing C# applications into G# projects** — producing *canonical* G#, not a literal transliteration.
2. **Discover gaps in the G# compiler** — by feeding the generated G# through a real build/verify/test pipeline and turning every failure into a filed issue, then re-running against an updated compiler until parity with the original C# is reached.

The hard requirement is that the process be **accurate and repeatable**: the same corpus run twice against the same `gsc` must produce the same G#, the same diagnostics, and the same triage artifacts. "Migration completed" has a precise meaning — the ported program compiles cleanly, its IL verifies, and its ported tests reproduce the C# baseline.

Two constraints bound the solution space. First, ADR-0027 removed Roslyn from the *compiler*: `gsc` has no `Microsoft.CodeAnalysis` dependency and emits ECMA-335 directly via `ReflectionMetadataEmitter`. Any use of Roslyn in this tool must not reintroduce that dependency into the compiler. Second, issue #914 mentions "pass the output to an LLM so it can file issues" — but a batch pipeline that embeds an LLM API client (and therefore API keys, network egress, and non-determinism) would violate the repeatability requirement and the repo's secret-handling rules. The triage hand-off must be designed around that.

The scaffolded solution under `tools/cs2gs/` already fixes the project decomposition this ADR fills in:

| Project | Responsibility |
| --- | --- |
| `Cs2Gs.CodeModel` | The purpose-built **G# emit AST** and the canonical pretty-printer. |
| `Cs2Gs.Translator` | Roslyn front-end: `CSharpCompilation` + `SemanticModel` → `Cs2Gs.CodeModel`. References `Microsoft.CodeAnalysis.CSharp`. |
| `Cs2Gs.Pipeline` | The ordered Translate → Compile → IL-verify → Test-parity stage machine and triage emission. |
| `Cs2Gs.Report` | HTML + JSON report aggregation. |
| `Cs2Gs.Cli` | The `cs2gs` entry point wiring Pipeline + Report together. |
| `Cs2Gs.Tests` | xUnit tests for the above. |

## Decision

Build `cs2gs` as a **Roslyn-based, offline, deterministic** translator feeding a **four-stage gap-discovery pipeline**, with structured triage artifacts consumed by an *external* issue-filing agent. The tool lives entirely under `tools/cs2gs/` and is never referenced by `gsc` or any compiler/runtime assembly.

### A. Translation approach: Roslyn front-end → dedicated emit AST → canonical pretty-printer

`Cs2Gs.Translator` parses each input with Roslyn into a `CSharpCompilation`, binds a `SemanticModel`, and walks the bound tree to build a tree of `Cs2Gs.CodeModel` nodes — a **purpose-built G# emit AST** owned by this tool. `Cs2Gs.CodeModel` then **pretty-prints canonical G#** (section B). Before any generated `.gs` reaches `gsc`, the pretty-printed text is **round-trip validated by re-parsing it with the real G# parser** (`Gsharp.CodeAnalysis` syntax API, consumed read-only as a library reference); a file that does not parse is a translator bug and fails the Translate stage *before* a compile is ever attempted (section C).

This is chosen over the two alternatives named in issue #914 and one additional design that surfaced:

- **vs. a hand-rolled C# parser.** A hand-rolled parser would have to re-implement C#'s lexer, parser, *and* its semantic model — overload resolution, generic inference, `var` type inference, definite-assignment, nullable flow — to know, e.g., whether a C# `var` local is immutable or what concrete type a method group resolves to. That is years of work that Roslyn already does correctly and that the C# language evolves under us. Rejected.

- **vs. a Roslyn analyzer that builds the *compiler's* G# AST.** Two problems. (1) It would couple the tool to `gsc`'s internal *parse-oriented* syntax tree, whose shape is tuned for binding/emit and carries trivia, spans, and invariants that a translator must satisfy but does not want. (2) It blurs ADR-0027's boundary: the compiler's AST would acquire a Roslyn-shaped construction path. Rejected in favor of a dedicated emit AST that the pretty-printer owns end-to-end.

- **vs. reusing the compiler's syntax tree as the emit AST.** Even setting aside the analyzer framing, the compiler's `SyntaxTree` is an input contract (it must round-trip source text faithfully, preserve trivia, and back a `SemanticModel`); an *emit* AST is an output contract (it only needs to render canonical text and is free to normalize, drop, and re-shape). Conflating the two makes both harder. A small, output-only `Cs2Gs.CodeModel` keeps the translator's job — "decide the canonical G# shape" — separate from the printer's job — "render it deterministically." Rejected reuse.

Why Roslyn here does **not** contradict ADR-0027: ADR-0027 removed Roslyn from the *compiler/emit pipeline* (`Lexer → Parser → Binder → Lowerer → ReflectionMetadataEmitter`), because Roslyn's distinctive value (projecting G# symbols as `ISymbol`, hosting G# inside the Roslyn driver) is not on the v1.0 critical path and would import a multi-million-line rebasing burden into `gsc`. `cs2gs` uses Roslyn for the **opposite** direction and in a **different process**: as an *external, offline C# front-end* that reads *C#* source and never touches the G# compiler's metadata writer. The dependency lives only in `Cs2Gs.Translator` (`PackageReference Microsoft.CodeAnalysis.CSharp`); `gsc` gains no `Microsoft.CodeAnalysis` reference, loads no Roslyn assembly at startup, and incurs no fork. The two ADRs are therefore consistent: "no Roslyn *in the compiler*" (ADR-0027) and "Roslyn *as a C# reader in a sibling tool*" (this ADR) describe disjoint surfaces.

### B. Definition of "canonical G# output"

This is the contract the pretty-printer in `Cs2Gs.CodeModel` must satisfy. Output is **deterministic** (identical input → byte-identical output) and **idiomatic** (matches the house style of `samples/*.gs`). The translator **never guesses**: a C# construct with no established canonical G# form is *not* approximated — it is recorded as a structured *unsupported-construct* triage record (section D) and, where the file can still be emitted, marked at the offending site, so the pipeline surfaces the gap rather than inventing syntax.

#### B.1 File, package, and import layout

- One C# file → one `.gs` file. The first non-comment line is `package <Dotted.Name>` derived from the C# file-scoped/namespaced namespace (multiple namespaces in one file are split or hoisted to the dominant namespace; ambiguity → triage). Grammar: `PackageDecl = "package" identifier { "." identifier }` (spec §Packages and imports).
- `using X.Y;` → `import X.Y`; `using A = X.Y;` → `import A = X.Y` (ADR-aligned alias form, spec §Packages and imports). One import per line, original order preserved, `import` block directly under `package`.
- `System` is implicitly imported by the compiler, but the printer still emits an explicit `import System` when the C# file used it, matching `samples/*.gs` (e.g. `Class.gs`), so the file is legible and `/noimplicitimports`-safe.
- `global using` and `using static` map to `import` where a direct equivalent exists; `using static` with no G# equivalent for member-hoisting is triaged.

#### B.2 Indentation and brace style

- **4-space indentation**, no tabs.
- **K&R / same-line braces**: the opening `{` sits on the declaration/statement line, the body is indented one level, the closing `}` aligns with the opener's line. This matches every sample (`Class.gs`, `Struct.gs`, `DataStruct.gs`). One blank line between sibling member declarations; no trailing whitespace; file ends with a single newline.

#### B.3 `let` vs `var` vs `const` (immutability mapping) — ADR-0008, ADR-0067

| C# | G# | Rule |
| --- | --- | --- |
| `const X` | `const` | compile-time constant; initializer must be constant (ADR-0008). |
| `readonly` field | `let` field | immutable binding (ADR-0008 `let`; field keyword required by ADR-0067). |
| mutable field | `var` field | ADR-0067 requires the `var`/`let` keyword on every field. |
| local `var x = e` / explicitly-typed local **never reassigned** | `let x = e` | Roslyn data-flow (`SemanticModel`/`DataFlowAnalysis`) proves the local is never written after init → emit immutable `let`. |
| local that **is** reassigned | `var x = e` | mutable binding. |

The immutability decision is driven by Roslyn's definite-assignment/data-flow analysis, not by the C# `var`/explicit-type spelling — C#'s `var` is a type-inference keyword, G#'s `let`/`var` is a mutability keyword (ADR-0008), so the mapping is semantic, not lexical. Type clauses are emitted only when C# wrote an explicit type *and* inference would be ambiguous; otherwise inferred (`let x = e`).

#### B.4 `class` vs `struct` vs `data class` vs `data struct` — ADR-0029, ADR-0025, ADR-0078, spec §Structs…

| C# | G# |
| --- | --- |
| `class` | `class` (reference) |
| `struct` | `struct` (value) |
| `record` / `record class` | `data class` (reference, structural members) |
| `record struct` | `data struct` (value, structural equality) |

`data class`/`data struct` synthesize equality and copy/update ergonomics (ADR-0029, ADR-0032). The `record` *keyword* is **not** emitted (removed by ADR-0078); the canonical spelling is `data class`/`data struct`. C# positional records map to the G# primary-constructor form (`data struct Point(X int32, Y int32)`), fields-only records to the body form. A C# `struct` with exactly one field that C# treats as a newtype is *not* auto-promoted to `inline struct` (ADR-0033) — that is a semantic judgment the tool will not make; it emits a plain `struct` and leaves `inline struct` adoption to the human.

#### B.5 Methods: in-body vs receiver-clause — ADR-0079, ADR-0024, spec §Functions and methods

Instance methods on a type the package **owns** (every type the translator emits) are declared **in-body** as `func M(...) R { ... }`, for **both `class` and `struct`** receivers. The receiver-clause form `func (r T) M(...) R` is **reserved for non-owned receiver types** — CLR/BCL types, primitives, and types from other packages — i.e. C# *extension methods* (`this T` first parameter). ADR-0079 (issue #719) made this the rule and emits the soft `GS0314` warning when a receiver clause names an owned type; `samples/MethodsWithReceivers.gs` is the canonical example (in-body method on an owned type) and `samples/ExtensionFunctions.gs` is the canonical receiver-clause example (on `int32`). Operator overloads keep the receiver-clause form and are exempt from `GS0314` (spec §Functions and methods).

C# **extension methods** (`static R M(this T self, …)`) translate to the receiver-clause form `func (self T) M(…) R` (ADR-0019), since `T` is non-owned by definition.

#### B.6 Inheritance and the `:` clause — ADR-0017, spec §Type declarations

- C# classes are sealed-by-default in G#; a base class that is subclassed must be emitted `open class`, and the overriding member must carry `override` (ADR-0017). The translator uses Roslyn's `INamedTypeSymbol.IsSealed`/`IsAbstract`/inheritance graph to decide: a class that any other corpus type derives from → `open`; a C# `abstract`/`virtual` member that is overridden → `open`/`override` on the pair. C# `sealed class` → plain `class` (already the default) or `sealed class` when it participates in a closed hierarchy switched on exhaustively (ADR-0078).
- The base clause lists the **base class first, then interfaces**: `class Dog : Animal, IBark { … }` (spec `BaseClause = ":" QualifiedTypeName … { "," QualifiedTypeName }`; `samples/Class.gs`). Constructor chaining renders as `: Base(args)` on the base clause or `init(...) : Base(args) { … }` (ADR-0065, `samples/ExplicitConstructor.gs`).

#### B.7 Generics — ADR-0020, ADR-0097, ADR-0098/ADR-0049

- Bracket form for both declaration and instantiation: `func Identity[T any](value T) T`, `List[int32]()` (ADR-0020). **No angle brackets** ever appear in output.
- Constraints render in the bracket: the legacy slot (`any`, `comparable`, sealed-interface bound) plus repeatable flag constraints `class`, `struct`, `new()` (ADR-0097). C# `where T : class` → `[T class]`, `where T : struct` → `[T struct]`, `where T : new()` → `[T new()]`, `where T : IFoo` → `[T IFoo]`. Variance `in`/`out` is carried on type parameters of interfaces/delegates (ADR-0021).

#### B.8 Delegate types — arrow form, ADR-0075

Delegate **types** render in the canonical arrow form `(A, B) -> R`, **never** `func(A, B) R` (that legacy spelling emits `GS0303`). Void returns spell `-> void`; multi-return spell `-> (T1, T2)`; async spell `async (T) -> R`. C# `Func<int,int>` → `(int32) -> int32`; `Action<string>` → `(string) -> void`; `Func<Task<int>>` → `async () -> int32`. A C# **named** `delegate` declaration becomes `type Name = delegate func(...) R` (ADR-0059, `samples/NamedDelegate.gs`) — the one place the `func` keyword stays, because it is a *named delegate declaration*, not a type clause. Function-literal expressions keep `func(x int32) int32 { … }`; arrow lambdas use `(x int32) -> expr` (ADR-0074).

#### B.9 String interpolation — ADR-0055, ADR-0007, ADR-0011

Every G# string literal is interpolation-capable (no `$` prefix; see `samples/InterpolatedString.gs`). Therefore:

- A C# **non-interpolated** literal containing a literal `$` must have each `$` escaped to `$$` on output.
- A C# **interpolated** string `$"...{expr}...{x:F2}..."` → `"...${expr}...${x:F2}..."`: each hole `{e}` becomes `${e}`, C# `{{`/`}}` become literal `{`/`}`, and any literal `$` in the surrounding text becomes `$$`. A bare `{ident}` may render as `$ident` only when `ident` is a simple identifier; complex holes always use `${…}`.
- Format/alignment specifiers inside holes are preserved (ADR-0055 rich holes).

#### B.10 Visibility and default-visibility mapping — ADR-0014, ADR-0109, ADR-0006

Defaults: top-level declarations default to `public` (ADR-0014); top-level `private` is permitted (ADR-0109). The printer emits an explicit accessibility modifier **only when the C# accessibility differs from the G# default for that position**, otherwise omits it for canonical minimalism:

| C# | top-level | member |
| --- | --- | --- |
| `public` | omit (default) | emit `public` where member default is not public |
| `internal` | `internal` | `internal` |
| `private` | `private` (ADR-0109) | `private` |
| `protected` / `protected internal` | nearest supported (`internal`) + triage note | as left |

`protected` has no direct G# spelling today; it is mapped to the closest accessibility and flagged in triage rather than silently dropped.

#### B.11 Members: fields, properties, constructors, statics, enums, attributes

- **Fields** require `var`/`let` (ADR-0067, §B.3).
- **Properties** → `prop Name T` for auto-properties, with `{ get { … } set(v) { … } }` bodies for computed/custom accessors (ADR-0051, `samples/PropertyRef/Lib/Lib.gs`). `open prop`/`override prop` mirror method virtuality.
- **Constructors** → `init(params) { … }`, chaining via `: Base(args)` (ADR-0065). C# primary constructors / positional records map to the G# primary-constructor `Name(params)` head.
- **Static members** → a `shared { … }` block (ADR-0053).
- **Enums** → `enum Name { A, B, C }` (`samples/Enum.gs`); payload-bearing C# unions (sealed hierarchy idioms) map to discriminated-union enums (ADR-0078 §5) only when the source is unambiguously that shape, else triaged.
- **Attributes** → `@Name(args)`, one per line, order preserved (ADR-0047): C# `[Obsolete("x")]` → `@Obsolete("x")`. Explicit attribute targets (`[return: …]`, `[field: …]`, `[assembly: …]`) map to the `@target:Name(...)` form.
- **`foreach`** → `for x in coll` (ADR-0031); LINQ/extension calls keep instance-call syntax (`xs.Where((x int32) -> x % 2 == 0)`, `samples/LinqExtensions.gs`).

#### B.12 Numeric type names and identifiers — ADR-0049, ADR-0098

Canonical output uses **width-bearing** primitive names (ADR-0049): C# `int`→`int32`, `uint`→`uint32`, `long`→`int64`, `ulong`→`uint64`, `short`→`int16`, `ushort`→`uint16`, `byte`→`uint8`, `sbyte`→`int8`, `float`→`float32`, `double`→`float64`, `bool`→`bool`, `string`→`string`, `char`→`char`, `object`→`object`. The friendly aliases (ADR-0098) parse, but the printer emits the canonical width-bearing form so output is uniform. **Identifier names are preserved verbatim** from C# (PascalCase types/members, camelCase locals) — the tool does not rename to a different casing convention.

### C. Pipeline stage contract

`Cs2Gs.Pipeline` runs four ordered stages per corpus app. Each stage has an explicit pass/fail gate; a failure short-circuits the remaining stages for that app, emits a triage artifact (section D), and is recorded in the run report. **"Migration completed" ≡ all four stages green: clean compile + clean IL verification + test parity with the original C#.**

| # | Stage | Action | Pass gate | On failure |
| --- | --- | --- | --- | --- |
| 1 | **Translate** | C#→G# via `Cs2Gs.Translator`; **round-trip parse** each emitted `.gs` with the real G# parser. | Every file parses; zero `unsupported-construct` records. | category `translation-unsupported`; stop. |
| 2 | **Compile** | Invoke `gsc` on the `.gs` set (slash-colon switches `/out: /target: /reference: /targetframework: /nowarn:`, per `src/Compiler/Program.cs`). | `gsc` exit 0, zero error diagnostics. | category `compile-error`, capturing every `GSxxxx`; stop. |
| 3 | **IL-verify** | `dotnet tool restore` then `dotnet tool run ilverify` (the repo-pinned `dotnet-ilverify`, `.config/dotnet-tools.json`) over the emitted assembly + its references. | `ilverify` reports no errors. | category `ilverify-failure`; stop. |
| 4 | **Test-parity** | Build the ported `@Fact`/`@Theory`/`@InlineData` G# xUnit tests (the `gsharp-xunit` shape) and run `dotnet test`; compare pass/fail set — and, where applicable, captured program stdout against the repo's `.golden` convention — to the **C# baseline oracle** (section E). | Ported tests reproduce the C# baseline (same tests pass) and optional stdout matches. | category `test-parity-failure`; stop. |

**`gsc` selection / retry semantics.** The pipeline takes a `--gsc <path>` override (defaulting to the repo build output) so a run can be re-executed against a freshly built compiler. When a stage fails because of a *compiler gap* (a missing feature or a bug, not a translator defect), the pipeline records the gap and its retry history; the external agent files an issue (section D); and the **entire run can be re-executed from stage 1** against the updated `gsc`. Retry is whole-corpus and idempotent: because translation is deterministic (section B) and the parity oracle is fixed (section E), the only variable across retries is the compiler, so a previously-red app turning green is unambiguous evidence the gap is closed. Each artifact carries a `retryHistory` so closed-then-reopened regressions are visible.

### D. Triage / issue-filing protocol (the "LLM hook")

**The pipeline calls no LLM API and embeds no keys or network egress.** Issue #914's "pass the output to an LLM" is realized as a *hand-off*, not an in-process call, preserving determinism and the repo's secret-handling rules. Each failing stage writes a **structured, machine-readable triage artifact** (JSON, one file per failure under the run directory). An **external agent** — GitHub Copilot, a human-in-the-loop, or a separate CI job — consumes these artifacts and files GitHub issues via `gh`, labeling each with **`Oats`** (the issue #914 program label) plus applicable labels such as `cil-emit` (stage 3 failures), `bug`, or `enhancement`.

#### D.1 Triage artifact JSON schema (v1.0)

```json
{
  "schemaVersion": "1.0",
  "runId": "2026-06-21T20-00-00Z_3f9c1a",
  "timestamp": "2026-06-21T20:04:12Z",
  "corpusAppId": "corpus/03-generics-linq",
  "gscVersion": "0.9.0+build.482",
  "stage": "compile",
  "category": "compile-error",
  "diagnostic": {
    "id": "GS0313",
    "message": "switch expression not exhaustive over sealed type 'Shape'",
    "severity": "error"
  },
  "sourceLocation": {
    "gsFile": "out/03-generics-linq/Shapes.gs",
    "gsLine": 42,
    "gsColumn": 12,
    "csFile": "corpus/03-generics-linq/Shapes.cs",
    "csLine": 51,
    "csColumn": 9
  },
  "offendingCSharpConstruct": {
    "kind": "SwitchExpression",
    "snippet": "shape switch { Circle c => ..., Square s => ... }"
  },
  "suggestedIssue": {
    "title": "[cs2gs] GS0313 on exhaustive switch over imported sealed hierarchy",
    "body": "Translating corpus/03-generics-linq/Shapes.cs ... <reproduction, expected, actual>",
    "labels": ["Oats", "bug"]
  },
  "fingerprint": "sha256:1b9d…e7",
  "retryHistory": [
    { "runId": "2026-06-20T18-00-00Z_a1", "gscVersion": "0.8.9+build.470", "result": "fail" }
  ]
}
```

Fields:

- `schemaVersion`, `runId`, `timestamp`, `gscVersion`, `corpusAppId` — provenance.
- `stage` ∈ `{translate, compile, ilverify, test-parity}`; `category` ∈ `{translation-unsupported, compile-error, ilverify-failure, test-parity-failure}`.
- `diagnostic` — the G# diagnostic id/message/severity (for stages 2–3; for stage 4 the failing test id and expected-vs-actual).
- `sourceLocation` — both the emitted-`.gs` location **and** the originating C# location (the translator preserves a source map so a gap points back to the C# that triggered it).
- `offendingCSharpConstruct` — the C# construct kind plus a minimal snippet.
- `suggestedIssue` — pre-rendered title/body/labels the external agent can file as-is or refine.
- `retryHistory` — prior `{runId, gscVersion, result}` records for this fingerprint.

#### D.2 Dedup fingerprint

`fingerprint = sha256( category + "|" + stage + "|" + diagnostic.id + "|" + offendingCSharpConstruct.kind + "|" + normalizedConstructShape )` where `normalizedConstructShape` strips identifiers/literals/line numbers down to the syntactic skeleton. The fingerprint **deliberately excludes** `runId`, `corpusAppId`, `gscVersion`, and concrete source positions, so the *same gap* hitting multiple corpus apps or recurring across runs collapses to **one** issue. The external agent keys on `fingerprint`: an artifact whose fingerprint already maps to an open issue updates that issue's occurrence list instead of filing a duplicate, and a fingerprint whose issue is closed but reappears reopens it.

### E. Corpus and parity oracle

A curated C# corpus of **increasing complexity** lives under `tools/cs2gs/corpus/`, one directory per app (e.g. `01-hello`, `02-classes-structs`, `03-generics-linq`, …). Every corpus app **green-builds and green-tests in C# first**; that captured C# state is the **parity oracle**:

- The C# xUnit results (pass/fail set per test) are recorded as the baseline the G# port must reproduce in stage 4.
- Where an app has deterministic console output, its stdout is captured as a `.golden`-style fixture (matching the repo's `samples/*.golden` convention) and compared after the G# build runs.

Corpus apps are ordered so early failures isolate the simplest possible gap. The oracle is regenerated only when the C# corpus itself changes — never as a side effect of a G# run — so retries (section C) compare against a fixed target.

### F. Reporting

`Cs2Gs.Report` produces, per run, **two** distributable artifacts:

1. A **single self-contained HTML file** (inlined CSS/JS, no external assets) with a per-app × per-stage status matrix, the discovered-gap list (grouped by `fingerprint`), and retry history — the human-facing dashboard.
2. A **machine-readable JSON summary** aggregating the same data (per-app/per-stage status, gap list keyed by fingerprint, retry history) for CI consumption and trend tracking.

Both are written under the run directory alongside the per-failure triage artifacts of section D.

## Consequences

### Positive

- **Determinism and repeatability.** No LLM in the loop, a fixed parity oracle, and a deterministic pretty-printer mean a run is reproducible; the only intended variable across retries is `gsc`.
- **Canonical output by construction.** Section B is an enforceable contract; round-trip parsing (section A) guarantees emitted G# is at least syntactically real before a compile is attempted.
- **Gap discovery is structured, deduped, and actionable.** Every failure becomes a fingerprinted artifact with a C#↔G# source map and a ready-to-file issue, so the compiler backlog is driven by real migration friction.
- **ADR-0027 boundary preserved.** Roslyn stays out of `gsc`; the dependency is quarantined in `Cs2Gs.Translator`.

### Negative

- **Roslyn dependency in the toolset.** `Cs2Gs.Translator` carries `Microsoft.CodeAnalysis.CSharp` (and its transitive MSBuild/crypto pins already present in the scaffold). This is a tool-only cost, not a compiler cost, but it is real maintenance surface.
- **Corpus curation is ongoing work.** The oracle's value scales with corpus breadth; building and maintaining green C# apps is a continuing investment.
- **"Canonical" must track the language.** Every new G# surface ADR may add or change a section-B rule; the pretty-printer is a living contract, not a one-time write.
- **Constructs without a canonical form are deferred, not translated.** `protected`, `inline struct` newtype promotion, some `using static` shapes, and any not-yet-mapped construct are triaged rather than guessed — correct, but it means some apps will not migrate until the language or the tool grows.

### Neutral

- The four-project decomposition (CodeModel/Translator/Pipeline/Report, plus Cli/Tests) matches the existing scaffold; this ADR fixes responsibilities, not the project layout.
- The triage schema is versioned (`schemaVersion`), so it can evolve without breaking older artifacts.

## Alternatives considered

**Hand-rolled C# parser + AST mapper.** Rejected — re-implements Roslyn's lexer, parser, and (critically) semantic model; cannot cheaply answer the immutability/type-inference questions section B depends on; perpetually chases C# language evolution.

**Roslyn analyzer that builds the compiler's own G# AST.** Rejected — couples the tool to `gsc`'s parse-oriented syntax tree and erodes the ADR-0027 boundary by giving the compiler's AST a Roslyn construction path. A dedicated, output-only emit AST (`Cs2Gs.CodeModel`) is cleaner and keeps "decide the shape" separate from "render the text."

**Reuse the compiler's `SyntaxTree` as the emit AST.** Rejected — an *input* contract (faithful round-trip, trivia, span invariants, `SemanticModel` backing) is the wrong shape for an *output* contract (normalize, drop, re-shape, render deterministically). Conflating them makes both jobs harder.

**Call an LLM API directly from the pipeline.** Rejected — embeds keys and network egress, introduces non-determinism, and breaks the repeatability requirement. The structured triage artifact + external `gh`-filing agent achieves the same outcome (issues get filed) while keeping the pipeline deterministic and secret-free.

**Skip round-trip parse validation and let `gsc` be the first reader of generated G#.** Rejected — it conflates *translator* defects (malformed G#) with *compiler* gaps (valid G# the compiler can't yet handle), polluting the gap signal. Re-parsing with the real G# parser before stage 2 cleanly separates the two.
