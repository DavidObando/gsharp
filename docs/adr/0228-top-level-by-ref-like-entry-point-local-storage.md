# ADR-0228: Entry-point-local storage for top-level by-ref-like (`ref struct`) bindings

- **Status**: Accepted
- **Date**: 2026-11-21
- **Phase**: Language semantics / CLR interop
- **Issue**: [#6169](https://github.com/DavidObando/gsharp/issues/6169)
- **Related**: [ADR-0056](0056-span-consumption-v1.md),
  [ADR-0058](0058-ref-safe-to-escape.md),
  [ADR-0066](0066-top-level-statement-mechanics.md),
  [ADR-0156](0156-gsi-emit-to-memory-execution.md),
  [ADR-0211](0211-utf8-span-literals.md),
  issue [#3215](https://github.com/DavidObando/gsharp/issues/3215)

## Context

Issue #367 originally rejected every top-level `ref struct` declaration with `GS0219` because top-level variables in `<Main>$` are promoted to `GlobalVariableSymbol`s and emitted as static fields on `<Program>`. The CLR forbids `IsByRefLike` types in static fields (`TypeLoadException`), so hoisting them to `<Program>` fails verification and runtime loading.

However, top-level statements execute inside a real CLR method body (`<Main>$`), where local IL slots can legally hold by-ref-like values (`Span[T]`, `ReadOnlySpan[T]`, `span[T]`, `readonly span[T]`, `DefaultInterpolatedStringHandler`, and user-declared `ref struct` types). Issue #3215 already established the exact non-hoisted storage mechanism for top-level managed pointers (`*T`, `ByRefTypeSymbol`): keep those `GlobalVariableSymbol`s out of `<Program>`'s static `FieldDef` table, allocate them as local slots inside `<Main>$`, and reject references from declared functions or lambdas with `GS9004`.

Because `GS0219` unconditionally rejected top-level `ref struct` declarations, straightforward executable snippets such as:

```gsharp
import System

let view readonly span[byte] = u8"hello"
Console.WriteLine(view.Length)
```

failed to compile at top level while the identical code worked inside `func Main()`.

## Decision

Admit top-level by-ref-like (`ref struct`) bindings in executable compilations using the same entry-point-local storage mechanism established for by-ref globals (#3215):

1. **Shared storage predicate (no type-name whitelist).** A top-level variable requires entry-point-local storage whenever `Type is ByRefTypeSymbol || TypeSymbol.IsByRefLike(Type)`. This applies uniformly to `Span[T]`, `ReadOnlySpan[T]`, `span[T]`, `readonly span[T]`, `DefaultInterpolatedStringHandler`, any other imported CLR `ref struct`, and user-declared `ref struct` types. Ordinary top-level variables keep static-field storage on `<Program>` and cross-function/cross-submission visibility unchanged.
2. **Entry-point-local emission only.** Non-hoisted top-level variables are excluded from `FieldRowPlan.Globals` and `<Program>` static `FieldDef` emission. `MethodBodyPlanner`, `SlotPlanner`, and `MethodBodyEmitter` allocate and access them as `<Main>$` IL local slots (`ldloc` / `stloc` / `ldloca`), never as static fields or boxed values.
3. **Library / entry-point-less compilations remain rejected.** When `IsLibrary` is `true` (e.g., `/target:library`) or no executable entry point exists (`function == nil`), top-level statements remain rejected with `GS0285`, and top-level by-ref-like declarations continue to report `GS0219`.
4. **Declared functions, local functions, methods, and lambdas (`GS9004`).** Any read, assignment, or indexed/member write targeting an entry-point-local top-level variable from outside `<Main>$` (`function == nil || !function.IsTopLevelEntryPoint`, including declared `func`s, methods, local functions, and lambdas) is rejected with `GS9004` (`ByRefCannotEscape`), never an internal compiler error (`GS9998`).
5. **Cross-file top-level statements and REPL/submission lifetime.**
   - Multi-file top-level statements in the same entry-point package concatenate deterministically into the single synthesized `<Main>$` body (ADR-0066 §2), so entry-point-local `ref struct` bindings are usable across those top-level statements within that single `<Main>$` invocation without emitting static fields. Multi-package TLS remains `GS0165`.
   - In interactive REPL/submissions (`EmittedSessionEngine` / `SubmissionImports`), entry-point-local bindings live only for the single submission cell's `<Main>$` execution: they are never hoisted to `<Program>` static fields, never echoed into `<Result>$`, omitted from `ReplState` snapshots, and never exported to subsequent submissions (referencing them from a later cell is rejected as undefined).
6. **Async suspension, `go`, and heap escapes (`GS0219`).**
   - When `<Main>$` is async (`await`), `RefStructAsyncLivenessAnalyzer` tracks entry-point-local by-ref-like variables with the same backward liveness analysis used for function locals: values live across a suspension point (`await` or inferred channel suspension inside an async `<Main>$`) report `GS0219`, while values consumed strictly before or created strictly after suspension remain legal `MoveNext` locals.
   - `go` expressions capturing a top-level `ref struct` binding report `GS0219` via `ClosureCaptureLegalityChecker`.
   - Boxing to `object`/interfaces, non-`ref struct` fields, non-`allows ref struct` generic type arguments, `scoped` return escapes, and iterator locals remain rejected with `GS0219`.

## Consequences

**Positive:**

- Top-level executable code and scripts (`gsc`, `gsi`) can declare and mutate CLR spans, UTF-8 span literals, and user `ref struct`s directly without wrapping everything in `func Main()`.
- Zero static `FieldDef` or boxing overhead for stack-only top-level values; PE metadata remains verifiable under strict `ILVerify`.
- Reuses the single `#3215` storage/emission seam (`GlobalFieldDefs` exclusion) and `RefStructAsyncLivenessAnalyzer` rather than inventing a parallel symbol kind or span-name whitelist.

**Negative / Neutral:**

- Top-level `ref struct` bindings cannot be accessed from helper `func`s or lambdas (`GS9004`), nor persisted across REPL submissions — users pass spans as parameters to helper functions instead.
- `RefStruct_AsTopLevelGlobal_Reports_GS0219` and executable top-level deconstruction tests are scoped to library/non-entry-point rejections while executable top-level bindings are tested as admitted.

## Alternatives considered

- **Whitelist `Span[T]` / `ReadOnlySpan[T]` only:** Rejected; violates type-system uniformity and leaves user-declared `ref struct`s and other CLR `ref struct`s broken.
- **Change `DeclarationBinder` to emit `LocalVariableSymbol` directly for top-level `ref struct`s:** Rejected; `GlobalVariableSymbol` + `PlanFieldRows` exclusion already handles `#3215` (`*T`), preserves semantic-model/PDB top-level variable visibility, and gives clear `GS9004` diagnostics when referenced from functions or lambdas rather than confusing scope errors.
- **Allow REPL submission persistence by boxing or copying spans:** Rejected; unsound and forbidden by the CLR (`TypeLoadException`) for arbitrary `ref struct`s.
