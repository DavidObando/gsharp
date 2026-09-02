# ADR-0175: Scoped diagnostic suppression (`@SuppressDiagnostic`)

- **Status**: Accepted
- **Date**: 2026-09-02
- **Related**: issue #3820 (the corpus-wide selfmig wall), issue #3824 (cs2gs drops `#pragma warning`), issue #3809 (made the translated analyzers effective), ADR-0169 (G# analyzer framework), ADR-0047 (annotations), ADR-0115 (cs2gs).

## Context

ADR-0169 gave G# analyzers and three ways to turn a diagnostic off:
`/nowarn:<ids>`, `/gsdiag:<ID>=<severity>`, and `.editorconfig`
`dotnet_diagnostic.<ID>.severity` (lowered to `/gsdiag:` by `BuildTask`).
All three are **whole-compilation**. G# had no way to say "this
diagnostic is wrong *here*, and only here".

C# has had one since 1.0: `#pragma warning disable/restore <ids>`.
`cs2gs` has never translated it — grep the translator for `PragmaWarning`
and there are zero hits; `AttachSourceComments` keeps the justifying
comment beside a suppression and drops the suppression itself. That was
invisible until #3809 populated `Symbol.ContainingType` on the semantic
model and the translated ADR-0169 analyzers started reporting. The
compiler's own deliberate `GSA0005` suppressions then fired in the
migrated tree, `migrated/src/Core` stopped compiling, and every app that
project-references it went red — a banked `greenApps` regression, gate
run `33636317883` at 29/52 against a floor of 43.

### Measured scope

562 `#pragma warning` occurrences across 130 files in the corpus, by
identifier family:

| family | occurrences | runs on G#? |
|---|---|---|
| `SA####` (StyleCop) | 474 | no |
| `CS####` (C# compiler) | 52 | no |
| **`GSA####` (G# analyzers)** | **20 (10 disable/restore pairs)** | **yes** |
| `IDE####` | 6 | no |
| `VSTHRD###` | 4 | no |
| `CA####` | 4 | no |
| `RS####` | 2 | no |

Only the `GSA` rows matter. The other 542 name analyzers that do not run
on G# at all, so translating them would emit annotations that suppress
nothing.

The ten `GSA0005` regions:

| file | lines | covers |
|---|---|---|
| `src/Core/CodeAnalysis/Lowering/SideEffectSpiller.cs` | 399–437 | `RewriteFieldAssignmentExpression` |
| `src/Core/CodeAnalysis/Binding/LambdaBinder.cs` | 2561–2582 | `RewriteFieldAssignmentExpression` |
| `src/Core/CodeAnalysis/Binding/LambdaBinder.cs` | 2588–2606 | `RewriteIndexAssignmentExpression` |
| `src/Core/CodeAnalysis/Binding/LambdaBinder.cs` | 2664–2698 | `RewriteReturnStatement` |
| `src/Core/CodeAnalysis/Lowering/Iterators/HoistedFieldRewriter.cs` | 176–191 | `RewriteIndexAssignmentExpression` |
| `src/Core/CodeAnalysis/Lowering/Iterators/HoistedFieldRewriter.cs` | 197–215 | `RewriteClrIndexAssignmentExpression` |
| `src/Core/CodeAnalysis/Lowering/CaptureBoxingRewriter.cs` | 645–672 | `RewriteFieldAssignmentExpression` |
| `src/Core/CodeAnalysis/Lowering/CaptureBoxingRewriter.cs` | 678–705 | `RewriteIndexAssignmentExpression` |
| `src/Core/CodeAnalysis/Lowering/CaptureBoxingRewriter.cs` | 710–758 | `RewriteClrIndexAssignmentExpression` |
| `src/Core/CodeAnalysis/Lowering/CaptureBoxingRewriter.cs` | 989–1024 | `RewriteVariableDeclaration` |

**Every one of the ten opens immediately before a method declaration and
closes immediately after that method's closing brace.** Not one is a
partial statement range. Declaration-level scope is therefore *exactly*
equivalent for the whole corpus — there is no fidelity/simplicity
trade-off to make here, and no `GSA0005` coverage is lost anywhere else
in those five files.

## Decision

G# grows **`@SuppressDiagnostic("ID", …)`**, an ADR-0047 annotation with
two positions:

1. **On any declaration an annotation may already precede** — type,
   function, property, field, event, enum member, parameter, local
   `var`/`let`/`const`. Scope: that declaration's span.

2. **On a block statement**, `@SuppressDiagnostic("ID") { … }`. Scope:
   the block's `{`..`}`. This gives a suppression a range narrower than a
   declaration, the direct analogue of a `#pragma` region inside a method
   body.

A diagnostic is dropped when its primary location falls inside a scope
naming its identifier. The check lives in `GSharpAnalyzerDriver.Report`
— the single funnel every analyzer diagnostic passes through — so `gsc`,
the language server, and `GSharpAnalyzerVerifier` honour identical
scoping without three implementations.

### It is compiler-intrinsic, not a CLR attribute

`@SuppressDiagnostic` names no type. It is recognised by source spelling
(`SuppressDiagnostic` or `SuppressDiagnosticAttribute`), consumed
straight from the syntax tree, and never written to metadata.

The alternative — a real attribute class — was rejected because G# has
no always-referenced runtime assembly (unlike Kotlin's `kotlin-stdlib`,
which is where `@Suppress` lives). A `SuppressDiagnosticAttribute` in
`GSharp.Core` would be unusable from any project that does not reference
`GSharp.Core`, which is most of them. Reusing
`System.Diagnostics.CodeAnalysis.SuppressMessageAttribute` was also
rejected: it demands a `Category` argument a `#pragma` cannot supply, its
`CheckId` convention is `"ID:Title"` rather than a bare identifier, and
it cannot annotate a block.

`DeclarationBinder.BindAttribute` intercepts the name before type
resolution and returns without producing a `BoundAttribute`;
`StatementBinder.BindBlockStatement` does the same for the block form.

### Grammar

The parser already reads leading annotations in statement position
(ADR-0047 §2 / issue #187) and then either attaches them to a
`var`/`let`/`const` declaration or reports GS0206. The block form adds
one branch: if the token after the annotations is `{`, parse a block and
attach.

- **Ambiguity: none.** One token of lookahead suffices. Before this ADR an
  `@` in statement position admitted only `const`/`let`/`var`, so a
  following `{` was always an error — the production is new, not
  reinterpreted.
- **Against the `{ … } + x` expression-continuation shape (#3355):**
  annotations *commit* the brace to a statement block. That shape is
  reachable only from a bare leading `{`, never through an annotation, so
  the `NestedBraceStartsContinuedExpression` probe is not consulted on
  the annotated path.
- **Against object/composite initializers:** those `{ … }` forms are
  parsed as expressions in expression position; an annotated block is
  only ever recognised in *statement* position, where a `{` is already a
  block.
- The block's annotations are excluded from its children
  (`[SyntaxChildIgnore]`) so its span stays exactly `{`..`}` — the span
  *is* the suppression scope, and a diagnostic reported on the annotation
  itself must not fall inside it.

### Semantics

- **Nesting**: scopes compose by union. An inner block adds its
  identifiers to whatever the enclosing scopes already suppress.
- **No re-enabling.** An inner scope cannot un-suppress an identifier an
  outer one suppressed. C#'s `restore` is a *position*, not a scope, so it
  can re-enable; a scoped model has no coherent way to express "re-enable
  within" without a second annotation form, and no corpus case wants one.
  If a narrower region needs the diagnostic live, move the suppression
  inward — the block form exists so that is always possible.
- **Multiple identifiers per annotation** are allowed:
  `@SuppressDiagnostic("GSA0005", "GSA0007")`, matching `#pragma`'s
  comma-separated list. Repeating the annotation is equivalent.
- **Identifier matching is case-insensitive** and keyed on the bare
  identifier, consistently with `/nowarn` and `/gsdiag:`.
- **Malformed identifier: diagnosed, not ignored** — new **GS9305**
  (Error). An argument must be a constant string shaped like a diagnostic
  identifier (ASCII letters then digits: `GS0157`, `GSA0005`,
  `PROBE001`). An empty argument list is likewise GS9305. A suppression
  that silently does nothing is precisely the failure mode this ADR
  exists to close, so the shape is checked at bind time.

### Deliberately deferred

- **Unknown-identifier reporting.** "`GSA0006` is not a diagnostic anyone
  declares" cannot be answered honestly per-project: an identifier may
  belong to an analyzer this project simply does not reference, and
  warning there would punish correct code. It needs a diagnostic-identifier
  registry spanning `gsc`'s descriptors and every loaded analyzer's
  `SupportedDiagnostics`, plus a rule for the unreferenced case.
- **Unused-suppression reporting.** Dead suppressions do accumulate
  (Roslyn's IDE0079 exists for this), and the driver already has the
  information — it knows which scopes matched. Deferred as a separate,
  opt-in diagnostic rather than bundled into the fix for a red gate.
- **Compiler (`GS####`) diagnostics.** The scope check runs in the
  analyzer driver, so today `@SuppressDiagnostic` covers analyzer
  diagnostics only. Extending it to `gsc`'s own diagnostics is a
  mechanical follow-up (the same map, consulted in
  `Program.ApplySuppressPromote`), deliberately not taken here to keep the
  blast radius of a gate fix small.

### cs2gs

`AttachPragmaSuppressions` runs beside `AttachSourceComments` on each
translated member. A `#pragma warning disable X … restore X` region
covering a declaration's *entire* span contributes
`@SuppressDiagnostic("X")` on the migrated declaration. Identifiers not
starting with `GSA` are dropped, as is a bare `#pragma warning disable`
with no identifier list (it names everything and has no faithful scoped
spelling).

A region that *cuts across* a declaration contributes nothing rather than
widening to the declaration — a widened suppression would hide violations
the C# source still reports, which is the one failure this ADR must not
introduce. No corpus region does this today; if one appears it surfaces
as a diagnostic rather than as silence. Translating a mid-body statement
range into the block form is a follow-up, unexercised by the corpus.

## Consequences

- The ten `GSA0005` suppressions in `src/Core` survive migration with the
  identical scope they had in C#: one method each, nothing wider.
- `gsc` gains GS9305. Both `docs/diagnostics.md` and
  `website/docs/ref/diagnostics.md` are updated.
- `BlockStatementSyntax` gains an `Annotations` list; `Parser.Statements`
  gains one branch; `GSharpAnalyzerDriver` gains one filter.
- The remaining ~542 non-`GSA` pragmas keep being dropped — now
  deliberately and documented, rather than by omission.

## Alternatives considered

- **Project-level `NoWarn` / `dotnet_diagnostic.GSA0005.severity = none`
  in the migrated tree.** Rejected. It unblocks the gate by deleting the
  analyzer's coverage across whole projects, so the gate would go green
  while the property it measures got weaker. `GSA0005` is also reported
  as an error, which `/nowarn` does not suppress.
- **A `#pragma`-equivalent directive.** Rejected. G# has no preprocessor
  and no directive trivia at all; this would be the first, for one
  feature. It buys exact positional parity with C#'s *restore*
  re-enabling, which nothing in the corpus uses, at the cost of new lexer
  and trivia infrastructure. Kotlin and Swift both express this as an
  annotation, and ADR-0047 already gives G# the grammar for one.
- **Declaration-level attribute only, no block form.** Sufficient for
  100% of today's corpus (all ten regions are whole-declaration). Rejected
  as a language decision: the moment a suppression is needed for three
  statements in a long method, the only options would be widening it over
  the whole method or splitting the method, and the widening is silent.
