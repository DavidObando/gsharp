# ADR-0150: Source decomposition conventions

- **Status**: Accepted
- **Date**: 2026-07-16
- **Phase**: Repository maintainability
- **Related**: #1361; Binder decomposition PR-B-1..B-9 (#577–#585); Emitter decomposition PR-E-1..E-12 (#586–#597)

## Context

Several source files have grown past 5,000 lines — `CSharpToGSharpTranslator.cs` reached 19,066, `ReflectionMetadataEmitter.cs` 12,868, `Parser.cs` 11,385 — making navigation, diff review, and parallel feature work painful. Issue #1361 proposed splitting them but predates two decomposition campaigns that already established the repository's structural idioms:

- **Binder decomposition (PR-B-1..B-9)**: extracted `BinderContext` as the shared-state foundation, then peeled `MemberLookup`, `ConversionClassifier`, `OverloadResolver`, `PatternBinder`, `LambdaBinder`, `StatementBinder`, `DeclarationBinder`, and `ExpressionBinder` out of `Binder`, which remains the coordinator.
- **Emitter decomposition (PR-E-1..E-12)**: extracted `EmitContext`, `MetadataTokenCache`, `WellKnownReferences`, `SlotPlanner`, then collaborators `ConversionEmitter`, `DataStructSynthesizer`, `MemberDefEmitter`, `TypeDefEmitter`, `ClosureEmitter`, `StateMachineEmitter`, `MethodBodyEmitter`, `CustomAttributeEncoder`.

Those campaigns shipped without an ADR; code comments reference a "repository-level decomposition plan" that is not in the tree. This ADR canonizes the conventions retroactively and governs the remaining #1361 work.

## Decision

### Decision rule: partials vs. composition

- **Partial-class split (pure file moves)** when the class's state is inseparable from its behavior (every method touches the same mutable core) or the class is a single tightly recursive algorithm. `Parser` is the canonical example: `position`, `recursionDepth`, and the disambiguation-suppression flags form one strongly connected mutual recursion across all grammar domains — there is no separable state for a collaborator to own. (Roslyn's `LanguageParser` reaches the same conclusion.)
- **Composition (collaborator class + shared context object)** when a band of methods owns identifiable state or operates over already-extracted context objects. `ReflectionMetadataEmitter`'s token-resolution band (thousands of lines over `EmitContext` + `MetadataTokenCache` + `WellKnownReferences`) is the canonical example.
- State itself is extracted into **context objects** (`EmitContext`, `BinderContext`) so that "where state lives" is decoupled from "where behavior lives"; collaborators receive context by constructor injection.

### Wiring idioms

- **Constructor injection** of context objects (`EmitContext`, `MetadataTokenCache`, `WellKnownReferences`, `BinderContext`).
- **Delegate callbacks** for methods still owned by the root, while the dependency count stays below roughly eight (`StateMachineEmitter` takes 11 and is at the practical ceiling).
- **Back-reference to the root** (`private readonly ReflectionMetadataEmitter outer;`) when the callback count would explode; root members are widened `private → internal` as needed (PR-E-11 precedent). Mutual recursion between peeled siblings is always wired through the root/coordinator back-reference, never sibling-to-sibling.
- **Transitional forwarders**: an extraction commit keeps one-line forwarders on the root so untouched call sites keep compiling; a dedicated cleanup commit re-points call sites and deletes forwarders (PR-E-12 `CustomAttributeEncoder` precedent).
- **No new public API**: extracted collaborators and context objects are `internal sealed class`; the only modifier added to existing types is `partial`.

### Partial-file conventions

- File names: `ClassName.Feature.cs`; every part declares the same modifiers (`internal sealed partial class X`); the base list appears only on the root part.
- The root part keeps all fields, consts, delegate type declarations, constructors, and properties. Nested types move with their sole consumer group; multi-consumer nested types stay in the root.
- Each part carries the standard copyright header (file name must match), the original file's `using` block, and its `#pragma warning disable` block (SA1201/SA1202 ordering rules are inherently violated by splitting; per-file pragmas are the established pattern, not `GlobalSuppressions`).
- Nested private classes may also be split: both the containing type and the nested type are declared `partial` (used for `CSharpToGSharpTranslator.DeclarationVisitor`).

### Verification protocol

- Pure-move commits: `git diff --color-moved=dimmed-zebra` must show only headers/usings/shells/pragmas as non-moved lines, plus a sorted-line conservation check (`diff <(git show <before>:<file> | sort) <(cat <parts>*.cs | sort)`).
- All commits: `dotnet build GSharp.sln -c Release -graph` with zero new StyleCop warnings, then the relevant test scope (`dotnet test` with per-project/namespace filters for targeted feedback; full suite at batch gates).
- Emit-layer extractions additionally: compile the `samples/` corpus before/after and byte-compare the emitted PEs — emit is deterministic (`ComputeDeterministicContentId`), so bit-identical output is the strongest possible no-behavior-change proof.

### Re-baselined completion criteria for #1361

The issue's original "all files under ~1,000 lines" is unrealistic for the parser and emitter roots. The criteria become:

- No independently ownable band of methods remains on a root class.
- Satellite partial files stay at or under ~2,000 lines.
- Root files contain only genuine orchestration plus inseparable state/dispatch.
- No behavioral changes; no new public API; all tests pass.

## Consequences

- Future feature work lands in focused files, reducing merge conflicts on hot classes (the parser, the binders, `DiagnosticBag`, the cs2gs translator).
- The decision rule prevents both failure modes: partial-splitting a class whose state deserved extraction (hides coupling), and force-composing a class with inseparable state (context-indirection tax with no payoff).
- Known follow-ups deliberately deferred: method-level decomposition of `DeclarationBinder.BindStructDeclarationBodyCore` (~2,300 lines, survives the file split intact), a `DiagnosticDescriptors` table for `DiagnosticBag` message definitions, and further `MemberLookup` grouping.

### Worked example: cs2gs translator — state extracted, collaborators rejected

The cs2gs `CSharpToGSharpTranslator.DeclarationVisitor` was split into 13 partial files and then had its ~25 mutable per-document fields extracted into a `DocumentTranslationState` object — the composable part. Peeling the translation methods themselves into collaborator classes (`PatternTranslator`, etc.) was attempted as a measured pilot and **rejected**: the visitor is a tightly mutually-recursive tree walker (pattern↔expression↔statement) with no ownable sub-state, so a single collaborator peel cost ~40 back-references into the visitor, 10 `private → internal` widenings, a nested-type visibility change rippling across all 13 partials, and StyleCop field→property/doc-ordering churn — the "force-composing inseparable state" failure mode above, with no payoff. This is the same call made for `Parser`: extract state where it exists, but keep tightly-recursive behavior as partials-with-shared-state rather than collaborators. The pilot commit is preserved on branch `refactor/1361-t2-pattern-translator` as evidence.
