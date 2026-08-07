# ADR-0155: Incremental nullable reference type adoption

- **Status**: Accepted (amended 2026-08-07 — see [Amendments](#amendments-2026-08-07))
- **Date**: 2026-08-03
- **Phase**: Repository maintainability
- **Related**: #1364, #3163; ADR-0150 (decomposition conventions), ADR-0154 (test oracle strength)

## Context

Nullable reference types are globally disabled via `<Nullable>disable</Nullable>` in `build/gsharp.build.props`; only `src/vs-gsharp` opts in at the project level. That means the compiler performs no null-state analysis over ~160K lines of production C#, and no API in `src/Core` carries a nullability contract — consumers (LanguageServer, Repl, tests, future SDK users) cannot tell which parameters and returns may be null. Latent null-dereference bugs have already surfaced where the implicit contracts were guessed wrong (issue #2144: a `default(TextLocation)` with a null `Text` NRE'd diagnostic rendering and masked the whole batch).

Two constraints bound the migration. First, `TreatWarningsAsErrors=true` is global, so any file placed in a nullable context must be warning-clean immediately — a big-bang flip of the central switch is not buildable. Second, `src/Core` is a single project, so "enable per subsystem" cannot be expressed as a per-project MSBuild property; the enablement boundary must be finer-grained than the project.

Two files (`Diagnostic/FileLogger.cs`, `Diagnostic/ILogger.cs`) already use per-file `#nullable enable` directives, establishing the in-repo precedent for sub-project opt-in.

## Decision

### Mechanism: per-file `#nullable enable`, directory-at-a-time

> **Amended (A1, A3).** Per-file directives apply to `src/Core` only; every other project flips via its own csproj property. The migration unit is a declared file set, not a directory. See [Amendments](#amendments-2026-08-07).

- The central `<Nullable>disable</Nullable>` in `build/gsharp.build.props` stays until the migration completes.
- A directory is migrated by adding `#nullable enable` to every `.cs` file in it and annotating until the solution builds clean under warnings-as-errors. The directive goes after the copyright header, separated by blank lines, before the `using` block (the `FileLogger.cs` layout).
- The unit of migration is the directory (subsystem), not the file: a directory is either fully enabled or fully untouched. No half-enabled directories.
- New files created in an enabled directory must carry `#nullable enable`. Reviewers treat a missing directive there as a defect.
- Once a file is enabled it stays enabled: no `#nullable disable` re-additions, and no `#nullable disable`/`#nullable restore` region escapes inside enabled files.

### Rollout order

> **Amended (A2).** The fixed list below assumes a dependency DAG that does not exist — `Symbols` and `Binding` are mutually dependent. The order is now: `Text/` → shared node types → `Syntax/` → the remaining cycle by measured warning cost → non-Core projects → the flip. See [Amendments](#amendments-2026-08-07).

Leaf, low-churn subsystems first; high-churn, high-fan-in coordinators last, so annotation work never collides with in-flight feature branches:

1. Leaf utilities: `src/Core/CodeAnalysis/Text/`, `src/Core/CodeAnalysis/Diagnostic/`, `src/Core/IO/` (this ADR's first slice)
2. `src/Core/CodeAnalysis/Syntax/` (nodes first, then parser)
3. `src/Core/CodeAnalysis/Symbols/`
4. `src/Core/CodeAnalysis/Lowering/`, `src/Core/CodeAnalysis/Emit/`
5. `src/Core/CodeAnalysis/Binding/` last (largest, highest churn)
6. Remaining production projects (`Compiler`, `Repl`, `LanguageServer`, `Sdk`, `Analyzers`), then test projects

Within a slice, dependencies must point outward only: an enabled directory may reference nullable-oblivious code (the compiler treats oblivious APIs leniently), but enabling a directory never requires editing files outside the slice.

> **Amended (A4).** The last clause is false: `src/Repl` is already nullable-enabled and consumes `Core`, so a Core slice can require edits there. The measured blast radius is small (3 warnings for the whole of Core), and it is useful signal rather than a problem. See [Amendments](#amendments-2026-08-07).

### Annotation rules

- **Annotate the real contract, don't launder warnings.** A member is declared `T?` only when null is a genuine, intended state that callers must handle (e.g. `SourceText.RawBytes` is null for non-file sources). If null was only ever an accident of construction, tighten the construction path and keep the non-null declaration.
- **`!` requires a justifying comment** adjacent to the use, stating the invariant that makes it safe. Uncommented `!` is a review defect.
- **Structs**: `default(T)` zero-fills reference fields regardless of annotations. When a default instance is a legitimate domain state (e.g. `default(TextLocation)` for location-less diagnostics), annotate the reference members `?` honestly and let members that are only meaningful on non-default instances document that precondition — do not pretend the field is non-null.
- **Oblivious boundaries**: values flowing in from not-yet-enabled code are trusted as declared. Do not add defensive null checks against oblivious callees; the check materializes when that directory is migrated.
- Prefer flow-friendly restructuring (pattern matching, early returns, locals) over `!` or redundant checks.

### Completion and tracking

- Issue #1364 carries the checklist of enabled directories; every slice PR updates it and states which directories it enabled.
- When every production source file is enabled, a final PR flips `build/gsharp.build.props` to `<Nullable>enable</Nullable>` and deletes all per-file directives in the same change. Test projects follow as a separate phase.

> **Amended (A5).** Directives are deleted per project, at the moment that project gains `<Nullable>enable</Nullable>` — not all at once in the final PR. This leaves the final PR as a pure MSBuild property change over byte-identical sources, which makes it provably a no-op. The final property is also conditional on `IsTestProject`, because test projects are deliberately staying oblivious. See [Amendments](#amendments-2026-08-07).

## Consequences

- Null-state analysis and explicit nullability contracts arrive incrementally without ever breaking the warnings-as-errors build, and without a long-lived migration branch.
- The leaf-first order means the highest-value contracts (widely consumed utility types) harden earliest, while `Binding/` — where in-flight feature work concentrates — is disturbed last.
- Per-file directives are visible noise in every enabled file until the final flip; the flip PR removes them wholesale.
- Enabled code referencing oblivious code gets lenient treatment at the boundary, so some null bugs remain invisible until the callee's directory migrates. This is the accepted cost of incrementality.
- Annotation may surface latent bugs (as #2144 did); fixing them is in scope for a slice when local, but behavior-visible fixes get their own commit and test.

## Alternatives considered

- **Issue #1364's original Phase 1** — flip the central switch to `enable` and stamp `#nullable disable` into every file. Rejected: it touches every file up front for zero analysis gain, inverts the reviewer signal (the marker would flag *unmigrated* files, so a new file missing a directive would silently join the migrated set unannotated), and mass-adds the exact directive this migration exists to remove.
- **MSBuild-conditional enablement** (e.g. an `ItemGroup` stamping `#nullable` via generated attributes, or splitting `Core` into per-subsystem projects). Rejected: C# offers no per-directory compiler switch short of project splits, and splitting `Core` is a far larger structural change than this migration warrants; per-file directives are the standard incremental path and already have in-repo precedent.
- **Big-bang annotation of `src/Core`**. Rejected: ~160K lines under warnings-as-errors cannot be made clean in one reviewable change, and it would conflict with every in-flight branch simultaneously.

## Amendments (2026-08-07)

Executing this ADR past its first slice required measurement it did not have. A sandboxed census — the whole solution built with `-p:Nullable=enable -p:TreatWarningsAsErrors=false -p:OutRoot=<scratch>`, which touches nothing in the tree — produced the first real numbers:

- **8,734 warnings in production C#** (tests add ~2,400 more and are out of scope; see A5). **Zero errors** — enabling nullability never breaks compilation anywhere in the repo, so the entire migration is warning resolution.
- Four diagnostics are 84.8% of the work: **CS8625** (null literal to non-nullable) 3,893, **CS8604** (possible null argument) 1,454, **CS8600** (null-to-non-nullable conversion) 1,155, **CS8603** (possible null return) 906. **CS8618** (uninitialized non-nullable member) adds 828.
- **CS8602 — dereference of a possibly null reference, the actual latent-NRE signal — is only 177 (2.0%).** The migration is overwhelmingly about *declaring* contracts, not about discovering crashes.

Counting note: diagnostics must be deduplicated on the full message, not on file/line/column. A constructor that leaves several properties unassigned reports one CS8618 per property, all at the same position; collapsing them undercounts CS8618 by a factor of three.

The amendments below follow from those numbers and from two structural facts.

### A1 — Per-file directives are for `src/Core` only

This ADR's mechanism section reads as though per-file directives are the migration's universal tool. They are not; they are a workaround for one property of one project. `src/Core` is a single csproj spanning every subsystem, so a sub-project boundary can only be expressed per file. Every other project is its own csproj and flips with one property — verified, since `src/Repl/Repl.csproj` already does exactly this and its setting wins over `build/gsharp.build.props`.

Non-Core projects therefore never receive directives. This removes roughly 150 of them from the migration.

### A2 — The rollout order is measured, not fixed, because the graph is cyclic

The ordered list in *Rollout order* assumes each subsystem sits above its dependencies. It does not: 11 files in `CodeAnalysis/Symbols/` `using ...Binding`, and 166 files in `CodeAnalysis/Binding/` `using ...Symbols`. `Symbols`, `Binding`, `Lowering`, `Emit`, `Documentation` and `Compilation` are one strongly connected component. Only `Text/` (migrated) and `Syntax/` (whose single outbound edge is `Syntax/Lexer.cs`) are genuinely acyclic. Within a cycle there is no "callees first".

Measured cost also inverts the LOC-based intuition the fixed order encodes:

| Subsystem | Warnings | LOC | Per 1k LOC |
|---|---:|---:|---:|
| `Binding/` | 3,465 | 113,755 | 30.4 |
| `Lowering/` | 1,095 | 16,601 | **65.9** |
| `Syntax/` | 1,159 | 27,568 | 42.0 |
| `Emit/` | 670 | 46,548 | **14.3** |
| `Symbols/` | 381 | 19,110 | 19.9 |

`Emit/` is 2.8× the size of `Lowering/` and carries 39% fewer warnings. Ordering by LOC would have scheduled these backwards.

**The replacement order cuts the cycle at its shared vocabulary.** The types the cycle is *made of* — the ~148 `Syntax/*Syntax.cs` and ~132 `Binding/Bound*.cs` node classes — are annotated first, across directory boundaries. Annotating them delivers contract signal to `Symbols`, `Binding`, `Lowering` and `Emit` simultaneously, which is the only way to supply a bottom to a graph that has none.

Node types are the right cut because their cost is **order-independent**. Enabling `Syntax/*Syntax.cs` alone produced 533 warnings against the 535 the full-tree census predicts for those files — a two-warning difference, so migrating them early costs no rework and creates no false work. That measurement is the empirical test for any future reordering: compare a directory's isolated warning count against its full-tree count, and prefer the slices where the two agree.

They are not, however, uniformly free. The bulk is CS8618 on node types with several constructor overloads, one per syntactic form, each assigning a different subset of properties — the honest annotation is `?` on the members a given form omits, which is a real contract statement rather than a mechanical fix.

The payoff is concentrated in a single declaration. `BoundNode.Syntax` is declared `public SyntaxNode Syntax { get; }` while its own doc comment states it is *"`null` when the node was synthesised by a lowering pass and has no direct source counterpart"*. **1,790 of the 3,893 CS8625 warnings — 22% of the entire production migration — are `null` passed as that constructor argument** (988 in `Binding/`, 645 in `Lowering/`, 157 in `Emit/`; the cluster alone is 59% of `Lowering/`'s total). Declaring it `SyntaxNode?` is a one-line change that makes the type say what the documentation already says.

This is also the migration's largest laundering hazard, and worth naming as such: declaring `Syntax` non-null and suppressing 1,790 sites with `!` would compile clean, satisfy every mechanical gate, and destroy the contract. The *Annotation rules* above govern; this is the case they were written for.

### A3 — The unit of migration is a declared file set, not a directory

"A directory is either fully enabled or fully untouched" is unworkable where directories are large: `CodeAnalysis/Binding/` is 196 files and 100,105 lines, which is not a reviewable change under any protocol. Sub-directory slices are therefore permitted, and the unit becomes a **declared, closed file set** recorded in `build/nullable-enabled.txt`.

The directory rule existed to guarantee something worth keeping — that no file in a migrated area is silently left unannotated. That guarantee is preserved, and strengthened, by moving it from review convention to a CI gate: `build/nullable_hygiene.py` verifies that every file matching an enabled glob carries the directive, that no `#nullable disable`/`restore` is reintroduced, and that no `CS8` suppression appears in a pragma, a `NoWarn`, or `.editorconfig`. All of those baselines are currently zero.

The check must parse rather than grep: 129 column-0 `#nullable` lines exist inside verbatim string literals in the cs2gs translation tests, and the `#nullable disable` region at `test/Core.Tests/CodeAnalysis/Symbols/ClrNullabilityTests.cs` is load-bearing — it exists precisely so the C# compiler emits no `NullableAttribute`, giving the G# metadata importer a genuinely oblivious type to import (issue #1354). It is a permanent allowlist entry and no cleanup may remove it.

### A4 — Core slices may require edits in `src/Repl`

The claim that "enabling a directory never requires editing files outside the slice" holds only while every consumer is oblivious. `src/Repl` is already nullable-enabled and consumes `Core`, so Core annotations are type-checked against it immediately. Measured blast radius for the whole of Core: **3 warnings**. This is a feature — Repl is the only annotated consumer, so every solution build tests each new Core contract against real annotated calling code for free.

### A5 — Directives are deleted per project; the final flip is conditional and provably inert

Rather than one final PR that both flips the switch and removes every directive, each project deletes its own directives at the moment it gains `<Nullable>enable</Nullable>` (for `src/Core`, that is the PR completing its last slice). The final PR then changes only an MSBuild property over byte-identical sources. With `Deterministic=true` already set, the assemblies it produces must be **byte-identical** to the previous commit's — an exact mechanical proof that the flip changed nothing, which is unavailable if source bytes move in the same change.

That final property is conditional, because the ~489k-line test tree is deliberately staying nullable-oblivious for now:

```xml
<Nullable Condition="'$(IsTestProject)' == 'true'">disable</Nullable>
<Nullable Condition="'$(IsTestProject)' != 'true'">enable</Nullable>
```

`IsTestProject` is already the flag this file uses to gate the ruleset, StyleCop and `DocumentationFile`, and it resolves correctly for every test project including the two outside `test/` that set it in their own csproj. The conditional is preferred over per-project properties because it makes **a newly created production project nullable by default**, which is the property the migration exists to establish.

Migrating the test tree is deferred rather than declined, and it is not a mechanical flip: 138 test files load their own assembly as a G# metadata reference, and `CodeAnalysis/Symbols/ClrNullability.cs` reads exactly the `NullableAttribute` data that annotating those fixtures would newly emit. Test annotation changes the input to the nullability importer that is itself under test, so it needs its own plan and its own witnesses.
