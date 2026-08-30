# ADR-0155: Incremental nullable reference type adoption

- **Status**: Accepted (amended 2026-08-07 — see [Amendments](#amendments-2026-08-07))
- **Date**: 2026-08-03
- **Phase**: Repository maintainability
- **Related**: #1364, #3163; ADR-0150 (decomposition conventions), ADR-0154 (test oracle strength)

## Context

Before issue #1364, nullable reference types were globally disabled via
`<Nullable>disable</Nullable>` in `build/gsharp.build.props`; only selected
projects opted in. The final flip now enables nullable analysis for production
projects by default while test projects remain flow-oblivious.

Two constraints bound the migration. First, `TreatWarningsAsErrors=true` is global, so any file placed in a nullable context must be warning-clean immediately — a big-bang flip of the central switch is not buildable. Second, `src/Core` is a single project, so "enable per subsystem" cannot be expressed as a per-project MSBuild property; the enablement boundary must be finer-grained than the project.

Two files (`Diagnostic/FileLogger.cs`, `Diagnostic/ILogger.cs`) already use per-file `#nullable enable` directives, establishing the in-repo precedent for sub-project opt-in.

## Decision

### Mechanism: per-file `#nullable enable`, directory-at-a-time

> **Amended (A1, A3).** Per-file directives applied to `src/Core` only; every
> other production project flips through shared build properties. The
> migration unit was a declared file set, not a directory. See
> [Amendments](#amendments-2026-08-07).

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
- When every production source file is enabled, the final PR flips
  `build/gsharp.build.props` conditionally and deletes the migration directives
  from `src/Core`. Test projects remain oblivious.

> **Amended (A5).** Directives are deleted per project, at the moment that
> project gains `<Nullable>enable</Nullable>`. The final property is
> conditional on `IsTestProject`, because test projects deliberately stay
> oblivious. This migration is complete for production projects.

## Consequences

- Null-state analysis and explicit nullability contracts arrive incrementally without ever breaking the warnings-as-errors build, and without a long-lived migration branch.
- The leaf-first order means the highest-value contracts (widely consumed utility types) harden earliest, while `Binding/` — where in-flight feature work concentrates — is disturbed last.
- Per-file directives are migration noise; the final flip removes the remaining
  `src/Core` directives.
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

"A directory is either fully enabled or fully untouched" was unworkable where
directories were large: `CodeAnalysis/Binding/` is 196 files and 100,105
lines, which was not a reviewable change under any protocol. Sub-directory
slices were therefore permitted; the temporary migration manifest was deleted
by the final flip.

The directory rule existed to guarantee something worth keeping — that no file
in a migrated area is silently left unannotated. The final-flip CI gate now
verifies the shared production/test defaults, that Core has no stale exact
`#nullable enable` directives, that no unallowlisted escape is reintroduced,
and that no `CS8` suppression appears in a pragma, a `NoWarn`, or
`.editorconfig`.

The check must parse rather than grep: 129 column-0 `#nullable` lines exist inside verbatim string literals in the cs2gs translation tests, and the `#nullable disable` region at `test/Core.Tests/CodeAnalysis/Symbols/ClrNullabilityTests.cs` is load-bearing — it exists precisely so the C# compiler emits no `NullableAttribute`, giving the G# metadata importer a genuinely oblivious type to import (issue #1354). It is a permanent allowlist entry and no cleanup may remove it.

### A7 — `Invariant.Required` for non-local invariants

The `!`-needs-a-comment rule holds, and for a local invariant it works well: the parser slice added 24 `!`, every one naming an enclosing guard or a constructor. It works badly where the invariant is real but non-local — a reflection result narrowed three frames up, a value established by a sibling constructor — because an honest comment there is long, and a short one is the laundering the rule exists to prevent.

`Invariant.Required(value, because)` (`src/Core/CodeAnalysis/Invariant.cs`) makes the invariant an artifact rather than a comment. It returns the value when the invariant holds and otherwise throws `InvalidOperationException` naming both the reason and — via `[CallerArgumentExpression]` — the offending expression, which the driver surfaces as GS9998 like every other broken invariant in Core. That is strictly more diagnosable than `!`, which converts a violated invariant into a bare `NullReferenceException` some frames later.

The rule for authors:

- **Local and crisply stateable** — "the enclosing `if` tested this", "the constructor assigns it" — keep using `!` with the comment. It is lighter and reads fine.
- **Non-local, or awkward to state in one line** — use `Invariant.Required`, and put the sentence you would have written as a comment into `because`.
- Neither is a licence to skip the thinking. If you cannot name what establishes the invariant, you do not have one; that is a latent bug, and A6's triage applies.

### A6 — Two kinds of warning, and only one of them is mechanizable

Slices 2–4 were driven almost entirely from the compiler's own output by rules that add `?` where the compiler proved a null flows. That worked because of what those slices' warnings *were*, and attempting the same on `CodeAnalysis/Syntax/`'s parser proved it does not generalise.

**Structural warnings** state a fact about a type in isolation. CS8618 — "a constructor overload leaves this member unset" — is the archetype: the node types are discriminated unions with one constructor per syntactic form, so a member the form omits is null, full stop. No caller can change that, the answer is local to the file, and 118 of the 132 members annotated across slices 2 and 3 already said so in their own doc comments. These are safe to mechanize.

**Flow warnings** state that a value *reached* somewhere. CS8600/CS8602/CS8604 on a local crossing a method boundary is the archetype. Each one has two correct resolutions, and choosing between them is the whole job:

- *Widen the callee* — declare the parameter or property `?`, because null is a real state it must handle.
- *Tighten the caller* — establish non-nullness at the construction site and leave the declaration alone.

ADR-0155's central rule already picks a default: "If null was only ever an accident of construction, tighten the construction path and keep the non-null declaration." **A rule driven by compiler output can only ever widen**, because widening is what silences the warning. Applied to the parser it produced, among 17 public API changes, four that were plainly wrong: `UnaryExpressionSyntax.Operand` and `LiteralExpressionSyntax.LiteralToken` became nullable though every call site supplies them, and `InterpolatedStringSegment.FromText`/`FromExpression` — factories whose entire purpose is to supply the value — took nullable parameters. Two further attempts widened `ParseExpression()` and `ParseStatement()` themselves, which would have forced a null check on roughly a hundred call sites for a null that never arrives.

Consequences for the plan:

- Node-type slices are cheap and safe to automate, and the payoff is concentrated there. That is now measured: slices 2–4 removed 2,528 of the 8,734 production warnings (29%) while touching 286 files that needed almost no judgment.
- Every remaining slice is flow-dominated and must be worked per site, with the tighten-vs-widen question asked explicitly. Automation may still *propose*, but a proposal that widens a public signature is a review item, not a result.
- The reviewable artifact is therefore the **public/internal signature diff**, not the file count. Extract it mechanically (`git diff | grep -E '^\+\s*(public|internal)' | grep '?'`) and require a null-producing call site for every entry. On the parser attempt that list was 17 lines and surfaced all four defects in a few minutes; the 685-line diff around it surfaced none.

### A4 — Core slices may require edits in `src/Repl`

The claim that "enabling a directory never requires editing files outside the slice" holds only while every consumer is oblivious. `src/Repl` is already nullable-enabled and consumes `Core`, so Core annotations are type-checked against it immediately. Measured blast radius for the whole of Core: **3 warnings**. This is a feature — Repl is the only annotated consumer, so every solution build tests each new Core contract against real annotated calling code for free.

### A5 — Directives are deleted per project; the final flip is conditional

Rather than one final PR that both flips the switch and removes every directive, each project deletes its own directives at the moment it gains `<Nullable>enable</Nullable>` (for `src/Core`, that is the PR completing its last slice). The final PR then changes only an MSBuild property over byte-identical sources. With `Deterministic=true` already set, the assemblies it produces must be **byte-identical** to the previous commit's — an exact mechanical proof that the flip changed nothing, which is unavailable if source bytes move in the same change.

That final property is conditional, because the ~489k-line test tree is deliberately staying nullable-oblivious for now:

```xml
<Nullable Condition="'$(IsTestProject)' == 'true'">disable</Nullable>
<Nullable Condition="'$(IsTestProject)' != 'true'">enable</Nullable>
```

`IsTestProject` is already the flag this file uses to gate the ruleset, StyleCop and `DocumentationFile`, and it resolves correctly for every test project including the two outside `test/` that set it in their own csproj. The conditional is preferred over per-project properties because it makes **a newly created production project nullable by default**, which is the property the migration exists to establish.

Migrating the test tree is deferred rather than declined, and it is not a mechanical flip: 138 test files load their own assembly as a G# metadata reference, and `CodeAnalysis/Symbols/ClrNullability.cs` reads exactly the `NullableAttribute` data that annotating those fixtures would newly emit. Test annotation changes the input to the nullability importer that is itself under test, so it needs its own plan and its own witnesses.

## Amendment (2026-08-10)

### A8 — What the build cannot check: four measured defect modes

A6 says the build is a complete decision procedure for a compile-time property, and treats an annotation-only slice as needing no test run. That is true of the *property* and false of the *edit*. On the branch completing this migration, ten tests were failing when the work was declared done — with a clean solution build under `TreatWarningsAsErrors` and a passing `nullable_hygiene.py` throughout. All ten came from two commits, in four shapes. Every one was found by a test suite; none by the build, the gate, or static analysis.

The four are recorded here because three of them look like good practice at review time.

**1. A null guard added to silence a warning.** The archetype:

```diff
-  if (memberType == null)
+  if (memberType == null || declaringType == null)
       return false;
```

The warning was on a constructor argument whose parameter was non-nullable. Widening the bail-out silenced it — and silently unbound `ifaceReceiver.DelegateProp(args)`, because a property declared on an *interface* legitimately has no `StructSymbol` declaring type. That regressed two shipped issues (#2925, #3016) and reported GS0159 instead. The correct fix was widening the constructor parameter, after which the guard returns to its original form.

> **Rule.** Resolving a nullable warning by adding or widening an `if (x == null) return/continue/throw` is a behaviour change, not an annotation. A guard is correct only when the null case genuinely has nothing to do — and then the comment must say so.

**2. `ImmutableArray<T>` normalization inverted.** `ImmutableArray<T>` is a struct, so it never produces a nullable diagnostic — yet `default(ImmutableArray<T>)` throws on enumeration. A helper existing purely to normalize that away was "tidied" into a no-op:

```diff
-    => types.IsDefault ? ImmutableArray<TypeSymbol>.Empty : types;
+    => types.IsDefault ? default : types;
```

Both arms type-check; the compiler cannot help at all. Six tests died on `InvalidOperationException` several frames away.

> **Rule.** `IsDefault` / `IsDefaultOrEmpty` guards are load-bearing and invisible to nullable analysis. Do not touch them during an annotation slice.

**3 and 4. False `Invariant.Required`.** Four shipped across the migration. A7 already states the rule — *"if you cannot name what establishes the invariant, you do not have one"* — and it did not hold in practice, because a plausible-sounding `because` is easy to write and nothing forces it to be derived from code. Two of the four were disproved by a null test in the *same method*; one asserted a value whose target parameter was *already nullable*, making the assertion pure noise that still crashed; and one asserted `BoundNode.Syntax`, whose nullability is this migration's own headline finding.

> **Rule.** The `because` must cite the construct that establishes the invariant — a named guard, constructor, or caller — not a restatement of the claim. Before writing one, check whether the target is already nullable; if it is, pass the value through.

### What follows for the gate

`nullable_hygiene.py` was extended in response:

- **`arg-null-bang`** — `f(null!)` now fails wherever `in_nullable_context` holds. It had been exempted wholesale on the grounds that passing null to a non-nullable parameter is how a test exercises an `ArgumentNullException` guard. That is true of tests and false of production, where fourteen had accumulated; nine marked genuinely over-strict contracts and five were dead `!` on already-nullable targets. Post-flip every test project is `Nullable=disable`, so scoping the check to `in_nullable_context` preserves the original rationale without an allowlist.

Two further checks are worth adding and are not yet implemented: flagging `Invariant.Required` whose target is already nullable (mechanical, and would have caught defect 4 on its own), and flagging a diff that both resolves a nullable warning and adds a null-comparison line (defect 1's signature).

### What follows for slice verification

A6's `classify` split — annotation-only versus behaviour-capable — is the right instrument and correctly flagged all four offending files as behaviour-capable. The gap is that nothing *required* the suites to run for them.

> **Rule.** A slice containing any behaviour-capable file is not done until `Core.Tests`, `Compiler.Tests` and `Interpreter.Tests` have all run green **on one tree with no rebuild in between**. Rebuilding mid-run invalidates the run; results from a tree that has since changed do not count.

`test/Core.Tests/Baselines/refactoring-baseline.json` is the cheapest strong oracle available: a byte-for-byte PE comparison that an annotation-only change cannot move. It stayed unchanged across the entire migration, which is what makes the emit-side claim credible.

Finally: any detector written to audit these shapes needs a mutation witness (ADR-0154). A first attempt at auditing the migration's 588 `Invariant.Required` sites reported zero hits and was simply broken — its method segmenter mis-parsed, and re-introducing a known defect failed to trip it. **A zero from an unwitnessed detector carries no information.**

## Amendment (2026-08-30)

### A9 — A null-accepting setter must say `[AllowNull]`; G# has only one contract per declaration

A5 leaves production annotated and the ~489k-line test tree oblivious, and A4 records the *read* direction of what that costs. Issue #3694 is the **write** direction, and it is the sharper one.

`Compilation.DebugInformation` is declared `DebugInformationOptions` — non-nullable — and its setter is `value ?? new DebugInformationOptions()`, i.e. it deliberately accepts `null`. Its own doc comment says so. An oblivious test writes `DebugInformation = null` and the C# compiler reports **nothing**: the write crosses a nullable-context boundary, so nothing ever checks the annotation against the code that contradicts it. The annotation is simply wrong, and the build cannot say so — a fifth entry in A8's catalogue of what the build cannot check, differing from the other four in that the *evidence* lives in a project the checker does not check.

> **Rule.** A setter that normalises `null` states that with `[AllowNull]` (`System.Diagnostics.CodeAnalysis`). C# splits a declaration into an input and an output contract; `[AllowNull] T P { get; set; }` is exactly "the setter takes `T?`, the getter returns `T`". Writing `T` alone claims a contract the setter does not enforce and the compiler will not test.

This is not only hygiene. G#, like Kotlin (ADR-0001), has **one** nullability per declaration — there is no separate write contract to widen, and no `!!` that can bridge "assign `nil` to a non-`nil` target"; `!!` forgives a nullable *value*, and a literal `nil` has nothing to forgive. So a null-accepting C# setter has exactly one faithful G# rendering, `T?`, and cs2gs promotes any source declaration carrying `[AllowNull]` to it (`ObliviousNullabilityAnalyzer.HasAllowNullWriteContract`). The getter widens with it and reads across the corpus pick up `!!` through the existing use-site pass; that is sound precisely because the setter's normalisation means the getter never returns `nil`.

The alternative — inferring the same promotion from the fact that *some oblivious consumer somewhere* writes `null` — was rejected. It makes a library's migrated public surface depend on its consumers, it can disagree between the project that emits the declaration and the project that writes to it, and it re-derives, from weaker evidence, a fact the author can simply state. The attribute is decided by the declaration alone, so every compilation in a migration run computes the same answer. Metadata-only declarations are excluded for the same reason: a referenced assembly's contract is already emitted, and gsc imports `[AllowNull] T` as plain `T`.
