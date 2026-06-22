# ADR-0115: Lambda / func-literal conversion to signature-compatible named delegates in overload resolution

- **Status**: Accepted
- **Date**: 2026-06-22
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #932 (`Assert.DoesNotContain(items, predicate)` rejected with `GS0159`)
- **Related**: ADR-0108 (delegate return-type covariance, #908); the
  lambda/delegate target-typing work in #889 (arrow lambdas as
  `System.Action`/void delegates), #891 (lambdas as named/extension-method
  arguments), #893 (func-literal trailing-return IL)

## Context

xUnit exposes predicate-shaped assertion overloads such as

```csharp
public static void Contains<T>(IEnumerable<T> collection, Predicate<T> filter);
public static void DoesNotContain<T>(IEnumerable<T> collection, Predicate<T> filter);
```

A G# user calling these with a lambda or func literal —

```gs
Assert.DoesNotContain(items, (i) -> i.Asin == "A3")
Assert.DoesNotContain(items, func (i LibraryItem) bool { return i.Asin == "A3" })
```

where `items` is an `IReadOnlyCollection<LibraryItem>` — was rejected by the
binder with `error GS0159: Cannot find function DoesNotContain.` The analogous
`Assert.Contains(collection, predicate)` overload failed identically. Plain
`Assert.Equal`/`Assert.NotEqual` worked, so general static-member call binding
was sound; the failure was specific to resolving the overload whose parameter
is a *named* delegate (`Predicate<T>`).

### Root cause

A G# lambda / func literal always has a *natural* type that is a
`FunctionTypeSymbol` whose CLR projection is a `System.Func<…>` /
`System.Action<…>` (`(string) -> bool` projects to `Func<string, bool>`).
Overload-resolution applicability is decided on CLR `Type`s by
`OverloadResolution.ClassifyImplicit`, which recognised a function-typed
argument against a delegate parameter only when:

- the delegate types were *identical* (`Func` → `Func`); or
- the source was a value-returning delegate and the target a `void` delegate
  (#889 discard); or
- the return type was reference-covariant (#908,
  `ImplicitConversionKind.DelegateReturnCovariance`).

There was **no rule** for a `Func<T, bool>` converting to a *distinct*
delegate type with the **same `Invoke` signature**, such as `Predicate<T>`.
So the predicate overload was classified inapplicable and, with no applicable
candidate, the binder reported `GS0159`.

This was purely an overload-resolution *applicability* gap. The downstream
func→named-delegate materialization already exists: `Conversion.Classify` →
`IsFunctionToDelegateConvertible` constructs the target delegate for the
selected literal argument and emits a valid adapter. Only the applicability
classifier needed to recognise the conversion so the candidate is selected in
the first place.

## Decision

Add a new, lowest-priority implicit-conversion kind,
`ImplicitConversionKind.DelegateSignatureMatch`, recognised by
`OverloadResolution.ClassifyImplicit` when:

- both the source (argument's natural type) and target (parameter) are
  delegate types; and
- they are **not** the same delegate type (identity is handled by the
  caller's identity check); and
- their `Invoke` signatures are identical — same parameter count, each
  parameter type the same, and the **same** return type (exact, not
  covariant).

This mirrors C#'s rule that an anonymous function converts to *any* delegate
type whose signature it matches, not just `Func`/`Action`. It covers
`Func<T, bool>` → `Predicate<T>`, `Func<T, U>` → `Converter<T, U>`,
`Action` → any signature-compatible named void delegate, and user-defined
delegates with a matching shape.

Key properties:

- **Ranked last.** `DelegateSignatureMatch` is the highest (worst) value in
  `ImplicitConversionKind`, so an exact (identity) `Func`/`Action` overload —
  or a return-covariant one — always wins betterness when more than one
  delegate overload is applicable. The named-delegate overload is selected
  only when it is the sole applicable candidate.
- **Mutually exclusive with `DelegateReturnCovariance`.** Differing
  (covariant) return types are deliberately excluded here and remain the
  domain of `IsDelegateReturnCovariant` (#908); the two rules never overlap.
- **Cross-context safe.** Delegate signatures are read via the existing
  `TryGetDelegateSignature` helper (the `Invoke` method, falling back to the
  closed `Func`/`Action` generic arguments) and compared by name, so the
  classification holds even when the target delegate is loaded through a
  `MetadataLoadContext` while the literal's natural `Func<…>` is a
  host-runtime constructed type. The check runs *before* the
  assignability / base-type-walk blocks, which can throw on cross-context
  constructed generics.

## Consequences

### Positive

- Both the arrow form `(i) -> …` and the explicit func-literal form
  `func (i T) bool { … }` bind against a `Predicate<T>` (or any
  signature-compatible named delegate) parameter on CLR static and instance
  method calls, compiling and emitting end-to-end. The realistic xUnit
  scenario — a test referencing the system-under-test's types — works.
- G# lambda→delegate conversion now aligns with C#'s anonymous-function
  conversion rule across the whole named-delegate family, so C# samples that
  rely on `Predicate<T>`/`Converter<T, U>` overloads port verbatim.

### Negative / trade-offs

- `DelegateSignatureMatch` adds one more special-case ranked conversion. It
  is ranked last so it can never shadow an exact or covariant match, but it
  is one more entry a maintainer must keep in mind when reasoning about
  overload betterness.

### Out of scope

- **Same-compilation element types.** When the collection's element type is a
  user type defined in the *same* compilation (rather than a referenced
  assembly), the static-call overload now resolves but emit hits a separate,
  pre-existing emitter limitation (`GS9998`: the selected method is closed
  over `object` while the lambda is bound over the real same-compilation
  type, requiring an unsupported `object`→user-type conversion in the
  delegate adapter). That gap affects `Func` overloads equally — it is not
  specific to the predicate shape #932 reports — and is left for a dedicated
  emitter change. The referenced-type case (the realistic xUnit usage) is
  fully fixed.
- Delegate **parameter-type** contravariance is unchanged (as in ADR-0108).

## Test coverage

- `test/Compiler.Tests/XunitAssertOverloadResolutionTests.cs` — four new
  regression tests drive `gsc` against the real `xunit.assert.dll`:
  `Assert.DoesNotContain` and `Assert.Contains`, each in both the arrow
  (`(v) -> v.Major == 3`) and func-literal
  (`func (v Version) bool { return v.Major == 3 }`) forms, over a
  `List[Version]` (a referenced element type with member access). Each case
  is asserted to compile *and* emit a valid assembly; all four reproduce
  `GS0159` before the fix and pass after it.

## Alternatives considered

- **A general variant-conversion table for delegates.** Rejected as
  over-broad and a soundness risk; the change is scoped to exact-signature
  named-delegate matches plus the existing return-covariance rule.
- **Special-casing `Predicate<T>` only.** Rejected: the same gap applies to
  `Converter<T, U>` and any user-defined delegate; matching by `Invoke`
  signature is the general, principled rule and mirrors C#.
- **Fixing the same-compilation emit path as part of this change.** Rejected
  as out of scope: it is a distinct emitter limitation affecting `Func`
  overloads too, unrelated to the predicate-specific applicability bug.

## References

- C# spec, *Anonymous function conversions* (an anonymous function converts
  to any compatible delegate type, not only `Func`/`Action`).
- ECMA-335 — delegate `Invoke` signature and reference-conversion rules.
- Issue #932 — original report, repro, and root-cause analysis.
- ADR-0108 — delegate return-type covariance (the adjacent ranked
  conversion).
