# `samples/refactoring-baseline/` — curated fixtures for the IL byte-identical gate

These tiny `.gs` files are the inputs to
`test/Core.Tests/CodeAnalysis/Emit/RefactoringBaselineTests.cs` — the PR-0
gate that pins the SHA-256 of the deterministic emitted content (metadata
stream with MVID zeroed, plus every method body's IL bytes) for every
sample. The gate exists so that the upcoming `Binder.cs` /
`ReflectionMetadataEmitter.cs` decomposition cannot silently change
emitted IL.

Each fixture corresponds to a code path the decomposition will touch. The
shapes are drawn from the Wave-1 P0/P1/P2/P3 audit (#418–#421) and the
Wave-3 user-porting cluster (#502–#575).

## Shape coverage

| File | What it pins | Issue(s) |
|------|--------------|----------|
| `ShortCircuitAnd.gs` / `ShortCircuitOr.gs` | `&&` / `\|\|` with side-effecting RHS — `SideEffectSpiller` (#476) and the lowering of short-circuit operators | P0-1 family |
| `ReturnInTryFinally.gs` | `return` inside a `try`/`finally` — must lower to `leave`/`endfinally` | P0-2 |
| `YieldInTryFinally.gs` | `yield` inside `try`/`finally` — iterator-side `TryDispatchPlanner` | P0-3 |
| `AwaitInFieldAssignment.gs` | `await` inside a field-assignment position — `SpillSequenceSpiller` field-assignment arm | P0-4 |
| `AwaitInIndexAssignment.gs` | `await` inside an array-index-assignment position — spiller index-assignment arm | P0-4 |
| `AwaitInUnary.gs` | `await` inside a unary-operator position — spiller unary arm | P0-4 |
| `GenericMethodSpec.gs` | static generic method called with a user-type generic argument — `MethodSpec` cache key | P3-7 dedup |
| `RefStructByRefLike.gs` | a user `ref struct` triggers `IsByRefLikeAttribute` emit on the TypeDef | P3-11 |
| `ReadOnlyAttr.gs` | an `inline struct` triggers `IsReadOnlyAttribute` emit on the TypeDef | P3-11 |
| `NullablePropertyRead.gs` | `Nullable[T]` instance member access (`.HasValue`, `.Value`) on a `var` | #504 / #517 (fixed) |
| `NullableValueMember.gs` | `Nullable[T]` produced by a `?.` chain, with `.HasValue` / `.Value` in a conditional | #504 / #517 (fixed) |
| `ClosureCaptureRefTypeField.gs` | closure captures a reference-type local and reads a field on it (the #523 → #567 regression repro) | #567 (open) |
| `ForInIEnumerable.gs` | `for x in y` over `IReadOnlyList[T]` | #538 (fixed) |
| `EnumBitwise.gs` | `\|`, `&`, `^` on CLR enum values (`FileShare`) | #534 (fixed) |

## Skipped fixtures

The gate compares each fixture against an entry in
`test/Core.Tests/Baselines/refactoring-baseline.json`. Entries whose value
is `null` are intentionally skipped — either the fixture does not
currently compile on `main`, or its emitted IL is not byte-deterministic
across compiles within the same process.

| File | Skip reason |
|------|-------------|
| `ClosureCaptureRefTypeField.gs` | Issue #567 (open) — the binder reports `Variable 'h' has no local slot or parameter index in the current method.` This is the exact regression the fixture is here to capture; once #567 lands, regenerate the baseline so the fixture is locked. |
| `YieldInTryFinally.gs` | Compiles cleanly but the emitted state-machine `MoveNext` body shuffles its basic-block order between compiles within the same process. The reordering is driven by reference-identity hash codes in an emitter-side dictionary and is unrelated to the iterator/try-finally lowering this fixture is meant to pin. Recorded as `null` so the gate stays a gate; tracked separately as compiler-determinism follow-up. Once the emitter visits its dictionaries in deterministic order, regenerate the baseline. The flaky-emit list lives in `RefactoringBaselineTests.KnownFlakyEmitSamples`. |

`samples/FuncToDelegate.gs` (not a refactoring-baseline addition) is also
in the flaky-emit list for the same reason as `YieldInTryFinally.gs`; it
appears in `RefactoringBaselineTests.KnownFlakyEmitSamples` so the gate
records a `null` hash for it.

When any of these are fixed, regenerate the baseline (see
`test/Core.Tests/Baselines/README.md` for the procedure); the `null`
entries in the JSON will be replaced with real SHA-256 hashes and the
corresponding rows here should be deleted.
