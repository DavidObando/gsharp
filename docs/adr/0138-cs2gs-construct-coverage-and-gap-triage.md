# ADR-0138: cs2gs construct-coverage program and gap-triage automation

- **Status**: Accepted
- **Date**: 2026-07-03
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0115 (cs2gs migration tool), ADR-0027 (no Roslyn in the compiler), issue [#914](https://github.com/DavidObando/gsharp/issues/914)

## Context

ADR-0115 built cs2gs as a four-stage verification pipeline over a leveled app
corpus. That made coverage **corpus-driven**: a construct was covered when some
corpus app happened to exercise it, and gaps were ledgered by hand in
ADR-0115 §G. Three consequences accumulated:

1. There was no authoritative statement of which of the ~320 C# syntax-node
   kinds translate, which are deliberately rejected, and which are silent
   holes; the translator's `default:` fallthroughs made an accidental omission
   indistinguishable from a design decision.
2. `cs2gs migrate` never ran in CI, so the corpus rotted quietly (the L2/L3
   test-parity paths were broken for weeks without anyone noticing).
3. Gap→issue filing was manual, and §G — a decision record — was being edited
   like a ledger.

## Decision

### A. The construct inventory is the source of truth for C# coverage

`tools/cs2gs/coverage/csharp-construct-inventory.json` classifies **every**
Roslyn node `SyntaxKind` (tokens and unstructured trivia excluded;
preprocessor-directive and doc-comment structures kept so their exclusion is a
recorded classification) as one of:

- `Translated` — a direct canonical G# form (an ADR-0115 §B rule reference is
  required);
- `Lowered` — translated via a different canonical shape (e.g. query syntax →
  method chain);
- `UnsupportedByDesign` — deliberately rejected, with a rationale from the
  taxonomy in §B;
- `Gap` — a known hole with a tracking issue link;
- `Unclassified` — not yet audited; a **ratchet** in
  `ConstructInventoryGoldenTests` caps the count and only ever decreases.

`RoslynSurface` (Cs2Gs.Translator/Coverage) reflects the surface and is
golden-tested (`roslyn-surface.golden.txt`, header pinned to the Roslyn
assembly version): a Roslyn upgrade that adds node kinds fails the build until
`cs2gs coverage --write` appends the skeleton rows and a human classifies
them. The generated `docs/cs2gs-coverage-matrix.md` is drift-checked the same
way. A second reflection axis over concrete `CSharpSyntaxNode` classes guards
against kind-filter mistakes.

### B. Unsupported-by-design rationale taxonomy

| Rationale | Meaning | Examples |
| --- | --- | --- |
| `NoGsharpConstruct` | G# omits it; no mapping planned | `__makeref`/`__reftype`/`__refvalue`/`__arglist` |
| `Preprocessor` | Resolved by parse options before translation; inactive code dropped | all `#`-directive kinds |
| `ToolingScope` | Tooling/doc structure, not program semantics | XML-doc and cref kinds, `#line` |
| `SemanticsErased` | Legitimately disappears in canonical G# | `partial` merging |
| `Deferred` | Representable but postponed; **must** link a tracking issue | — |
| `NotReachable` | Unreachable as parsed C# 14 | `UnionDeclaration` (post-C#14 preview), error-recovery accessor kinds |

`lowered` is a supported status, not a rationale: the taxonomy applies only to
rejections. Contested classifications are arbitrated in the row's `notes`.

### C. The choke point: gap vs. by-design is machine-decided

`TranslationContext.ReportUnsupported` consults the
`UnsupportedByDesign` registry (built from the same structural rules that seed
the inventory; `TranslatorExhaustivenessTests` keeps them equal). A registered
kind keeps triage id `CS2GS-UNSUPPORTED`; an unregistered kind gets
`CS2GS-GAP`. An accidental fallthrough therefore cannot masquerade as a design
decision, and the grid/CI force it to be classified.

### D. The differential fixture grid

`tools/cs2gs/corpus/grid/G01…G14` are **console** apps (one construct per
`Constructs/<SyntaxKindName>.cs`, header comment `// inventory: <kind>`),
auto-discovered by `CorpusDiscovery`, each executable with a
`baseline.stdout.golden` byte-compared against the translated G# program in
stage 4 — so semantic divergence is caught per construct, not per app. Grid
apps stay fully green: a construct that fails any stage is quarantined out of
the app and ledgered/filed instead. Deliberately-rejected constructs get
in-proc fixtures under `Cs2Gs.Tests/Fixtures/Grid/Unsupported/` and never
enter the corpus.

The code-model/printer side is closed by `CodeModelSurfaceTests` (golden over
concrete `GNode` types + enums), `GNodeSamples` (a minimal unit per node
type), and `PrinterExhaustivenessTests` (print → round-trip-parse per type,
with `KnownRoundTripGaps` asserted to *keep failing* until fixed).

### E. The gap ledger and gate semantics

`tools/cs2gs/triage/gaps.json` is one artifact with two consumers: the
fingerprint↔issue map for automation and the CI baseline for
`cs2gs migrate --baseline`:

- **NEW** (fingerprint not ledgered) → exit 1;
- **KNOWN** (`open`/`wontfix`/`superseded`) → tolerated, listed;
- **REGRESSED** (`resolved` but reproducing) → exit 1;
- **STALE** (`open` but not reproduced by a full-corpus run) → warn on the PR
  gate; fails under `--baseline-strict` (nightly) so the ledger cannot rot;
- an **unverified** app (a stage skipped without an artifact) must be listed
  in the ledger's `unverifiedApps` or the gate fails — a skip must never
  render green (the issue #1831 class).

Every ledger mutation goes through a PR. `resolved` requires an
`Issue<N>*.cs` regression test (`cs2gs triage sync` refuses otherwise without
`--no-test-reason`).

### F. Automated issue filing

`cs2gs triage file-issues` files NEW fingerprints via `gh issue create`,
**clustered** by (diagnostic id, construct kind, stage) — one issue per root
cause, secondary fingerprints ledgered `superseded` — with a per-invocation
cap (default 10), a fingerprint search-before-create dedup (every body embeds
its fingerprints), stage labels `gap:compile|gap:ilverify|gap:parity` on top
of the artifact's suggested labels, and the DoD checklist from
`.github/ISSUE_TEMPLATE/compiler-gap.md`. The nightly workflow
(`cs2gs-nightly.yml`) runs it with `--file` under `GITHUB_TOKEN` and opens a
ledger-update PR; the PR gate (`build.yml` job `cs2gs`) never files, only
gates. Repro minimization remains a cheap human refinement on the auto-filed
issue.

### G. ADR-0115 §G is frozen

§G remains as the historical record of the #914 validation; the living ledger
is `gaps.json`. New gaps are filed as issues and ledgered, not appended to §G.

## Options considered

- **Node-class (not kind) inventory** — under-discriminates: one
  `BinaryExpressionSyntax` covers ~25 kinds with different rules. Rejected;
  kept as the secondary drift axis only.
- **Spec-section checklist** — not machine-checkable; rejected.
- **Human-approved filing** — rejected in favor of full automation with
  clustering/cap/dedup guardrails; the ledger PR keeps a human review point
  without blocking discovery.
- **Golden `.gs` text per fixture** — ~300 brittle text goldens; rejected in
  favor of behavioral oracles (stdout parity + round-trip + compile).

## Consequences

- A Roslyn bump is a deliberate event: surface golden fails → `cs2gs coverage
  --write` → classify the delta → tests green.
- The unclassified and fixture ratchets make coverage progress monotonic and
  visible in `docs/cs2gs-coverage-matrix.md`.
- CI fails only on *new* or *regressed* gaps, so known-open compiler work
  never blocks unrelated PRs, while silent rot (skips, stale entries) is
  caught by the strict nightly.
