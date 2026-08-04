# ADR-0155: Incremental nullable reference type adoption

- **Status**: Accepted
- **Date**: 2026-08-03
- **Phase**: Repository maintainability
- **Related**: #1364, #3163; ADR-0150 (decomposition conventions)

## Context

Nullable reference types are globally disabled via `<Nullable>disable</Nullable>` in `build/gsharp.build.props`; only `src/vs-gsharp` opts in at the project level. That means the compiler performs no null-state analysis over ~160K lines of production C#, and no API in `src/Core` carries a nullability contract — consumers (LanguageServer, Repl, tests, future SDK users) cannot tell which parameters and returns may be null. Latent null-dereference bugs have already surfaced where the implicit contracts were guessed wrong (issue #2144: a `default(TextLocation)` with a null `Text` NRE'd diagnostic rendering and masked the whole batch).

Two constraints bound the migration. First, `TreatWarningsAsErrors=true` is global, so any file placed in a nullable context must be warning-clean immediately — a big-bang flip of the central switch is not buildable. Second, `src/Core` is a single project, so "enable per subsystem" cannot be expressed as a per-project MSBuild property; the enablement boundary must be finer-grained than the project.

Two files (`Diagnostic/FileLogger.cs`, `Diagnostic/ILogger.cs`) already use per-file `#nullable enable` directives, establishing the in-repo precedent for sub-project opt-in.

## Decision

### Mechanism: per-file `#nullable enable`, directory-at-a-time

- The central `<Nullable>disable</Nullable>` in `build/gsharp.build.props` stays until the migration completes.
- A directory is migrated by adding `#nullable enable` to every `.cs` file in it and annotating until the solution builds clean under warnings-as-errors. The directive goes after the copyright header, separated by blank lines, before the `using` block (the `FileLogger.cs` layout).
- The unit of migration is the directory (subsystem), not the file: a directory is either fully enabled or fully untouched. No half-enabled directories.
- New files created in an enabled directory must carry `#nullable enable`. Reviewers treat a missing directive there as a defect.
- Once a file is enabled it stays enabled: no `#nullable disable` re-additions, and no `#nullable disable`/`#nullable restore` region escapes inside enabled files.

### Rollout order

Leaf, low-churn subsystems first; high-churn, high-fan-in coordinators last, so annotation work never collides with in-flight feature branches:

1. Leaf utilities: `src/Core/CodeAnalysis/Text/`, `src/Core/CodeAnalysis/Diagnostic/`, `src/Core/IO/` (this ADR's first slice)
2. `src/Core/CodeAnalysis/Syntax/` (nodes first, then parser)
3. `src/Core/CodeAnalysis/Symbols/`
4. `src/Core/CodeAnalysis/Lowering/`, `src/Core/CodeAnalysis/Emit/`
5. `src/Core/CodeAnalysis/Binding/` last (largest, highest churn)
6. Remaining production projects (`Compiler`, `Repl`, `LanguageServer`, `Sdk`, `Analyzers`), then test projects

Within a slice, dependencies must point outward only: an enabled directory may reference nullable-oblivious code (the compiler treats oblivious APIs leniently), but enabling a directory never requires editing files outside the slice.

### Annotation rules

- **Annotate the real contract, don't launder warnings.** A member is declared `T?` only when null is a genuine, intended state that callers must handle (e.g. `SourceText.RawBytes` is null for non-file sources). If null was only ever an accident of construction, tighten the construction path and keep the non-null declaration.
- **`!` requires a justifying comment** adjacent to the use, stating the invariant that makes it safe. Uncommented `!` is a review defect.
- **Structs**: `default(T)` zero-fills reference fields regardless of annotations. When a default instance is a legitimate domain state (e.g. `default(TextLocation)` for location-less diagnostics), annotate the reference members `?` honestly and let members that are only meaningful on non-default instances document that precondition — do not pretend the field is non-null.
- **Oblivious boundaries**: values flowing in from not-yet-enabled code are trusted as declared. Do not add defensive null checks against oblivious callees; the check materializes when that directory is migrated.
- Prefer flow-friendly restructuring (pattern matching, early returns, locals) over `!` or redundant checks.

### Completion and tracking

- Issue #1364 carries the checklist of enabled directories; every slice PR updates it and states which directories it enabled.
- When every production source file is enabled, a final PR flips `build/gsharp.build.props` to `<Nullable>enable</Nullable>` and deletes all per-file directives in the same change. Test projects follow as a separate phase.

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
