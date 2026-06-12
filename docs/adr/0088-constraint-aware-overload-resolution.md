# ADR-0088: Constraint-aware extension-method overload resolution

- **Status**: Accepted
- **Date**: 2026-06-22
- **Phase**: Binder hardening
- **Closes**: Issue #750 (Generic constraints ignored during overload resolution → wrong overload picked → IL fails verification)
- **Related**: ADR-0084 (Gsharp.Extensions Optional / Sequences — language-gap L1 was this bug); issue #697 (parent overload-resolution polish bucket); issue #724 (Extensions stdlib parent); ADR-0087 (reified-generics emit audit — composes cleanly with the new constraint check); parent issue #706 §5.12

## Context

The G# binder enumerates extension-method candidates by name and arity
and ranks them by parameter shape. Until this ADR, it did **not** read
the generic-parameter constraints attached to each candidate. That made
two extensions like

```csharp
public static U? Map<T, U>(this T? self, Func<T, U> f) where T : class { ... }
public static U? Map<T, U>(this T? self, Func<T, U> f) where T : struct { ... }
```

indistinguishable at the rank step: both were considered applicable for
every call site (because `T?` looks like the same nullable receiver
shape at the language level), the binder picked one arbitrarily, and
the emitter produced a `callvirt` against a generic method whose
constraints the runtime then rejected — the IL itself passes
`ilverify` (the metadata-load context happily writes a `MethodSpec`),
but the JIT throws `VerificationException` (or, worse, returns the
wrong overload silently when both shapes happened to match).

ADR-0084 documented this as the reason the `Gsharp.Extensions.Optional`
and `Gsharp.Extensions.Sequences` surfaces had to ship with a `*Value`
suffix on every value-typed helper. The duplicated surface (`Map` /
`MapValue`, `OrElse` / `OrElseValue`, `FirstOrNil` / `FirstValueOrNil`,
…) was an explicit wart. Issue #750 closes the binder gap; this ADR
captures the algorithm so the same fix doesn't regress.

### Root cause

The candidate-evaluation paths in
`src/Core/CodeAnalysis/Binding/OverloadResolution.cs` —
`EvaluateCandidate` and `EvaluateExpandedParamsCandidate`, both the
explicit-type-args branch and the inference branch — relied on
`MethodInfo.MakeGenericMethod(typeArgs)` throwing `ArgumentException`
when a constraint was violated, and used the throw as the "reject this
candidate" signal.

That works at runtime, but in the binder we go through a
`System.Reflection.MetadataLoadContext` (because the candidate
generally comes from a `/reference:` assembly). The MLC overload of
`MakeGenericMethod` **does not validate generic-parameter constraints**:
it silently constructs the `MethodSpec`. So every constraint-violating
candidate survived applicability filtering, two disjoint-constraint
overloads collided as "equally specific", and the binder picked one.

## Decision

The binder now performs constraint validation on every generic
candidate it considers. The algorithm has three pieces:

### 1. Filter — `SatisfiesGenericConstraints(openMethod, typeArgs)`

For each generic type parameter `Ti` of the open method definition,
compute the per-parameter constraint set from
`Ti.GetGenericParameterConstraints()` and
`Ti.GenericParameterAttributes`, then check the candidate type argument
`Ai` satisfies all of them:

- `ReferenceTypeConstraint` (`where Ti : class`) → require `Ai` to be a
  reference type (`Ai.IsValueType == false` and `Ai` is not
  `System.ValueType`/`System.Enum`).
- `NotNullableValueTypeConstraint` (`where Ti : struct`) → require `Ai`
  to be a non-nullable value type (`Ai.IsValueType == true` and not
  `Nullable<T>`).
- `DefaultConstructorConstraint` (`where Ti : new()`) → require `Ai`
  either to be a value type, or to expose a public parameterless
  constructor.
- Each base/interface bound returned by
  `GetGenericParameterConstraints()` → require `Ai` to be assignable to
  that bound (handles `where Ti : SomeBase`, `where Ti : ISomeIface`,
  and projected dependent constraints like `where U : T`).

If any constraint is violated, the candidate is dropped before
ranking. The check runs in both `EvaluateCandidate` and
`EvaluateExpandedParamsCandidate`, on both the explicit-type-args path
and the type-inference path. **Constraints are checked AFTER type
inference**: the inferred or supplied `typeArgs` set is what the
constraint check sees. If inference picked an open type that satisfies
one candidate's constraints but not another's, that determines the
winner without further work.

### 2. Tie-break — constraint specificity

When multiple candidates survive applicability and parameter-shape
ranking, the binder applies an additional "Phase 2e" rule that prefers
the candidate whose generic-parameter constraints are strictly more
specific. The specificity score per parameter is:

| Constraint | Score |
| --- | --- |
| `where T : struct` | 2 |
| `where T : class` | 1 |
| (no constraint) | 0 |

(Base/interface bounds and `new()` are not part of this ordering: by
the time two candidates have both passed applicability they have
already proven they accept the actual type argument, so further
"more interface-bounded → more specific" gymnastics would be
arbitrary.)

Candidate A wins over candidate B iff every type-parameter slot's
score on A is **≥** B's AND at least one slot is strictly greater.
Mutually-incomparable cases (e.g. A has `struct` on `T1` but `class`
on `T2`; B has the reverse) are unranked at this stage and fall
through to the existing ambiguity report (`GS0160`).

The intuition: `struct` and `class` are mutually disjoint partitions of
the type-argument space, so a candidate carrying a constraint accepts
strictly fewer type arguments than one that doesn't, and a candidate
carrying `struct` is more specific than one carrying `class` for the
purposes of resolving competing same-named extensions across multiple
namespaces. (For two candidates on truly disjoint constraints —
`class` vs `struct` — at most one will survive the filter step, so
the tie-break is a no-op in that common case; it only fires for the
`class | none` and `struct | none` cases.)

### 3. Interaction with existing rules

- The constraint check runs **after** parameter-shape applicability
  (otherwise we'd reject candidates whose constraints depended on
  failed inference) but **before** the existing specificity tie-break
  on parameter types. Specificity on parameter types still wins when
  applicable; constraint specificity is a later, lower-priority
  tie-break.
- Receiver-clause extension methods, instance method binding, and
  static method binding all flow through the same
  `EvaluateCandidate` / `RankApplicable` path, so the rule applies
  uniformly. Generic type parameters on the enclosing type
  (`MethodInfo.DeclaringType.GetGenericArguments()`) are not part of
  the candidate's open generic args and are not re-checked here —
  they're already pinned by the receiver type.
- The fix composes cleanly with ADR-0087 reified-generics emit:
  reified open shapes flow through the existing emit path; the
  binder is purely the gatekeeper that decides which candidate to
  emit a `call` / `callvirt` for.

### 4. Diagnostics

The constraint-disjoint ambiguity case (two candidates pass the
filter, neither dominates the other in specificity) reports via
the existing `GS0160` ambiguous-overload diagnostic. The message
text already lists the candidate signatures; readers can see the
disjoint constraints in the listing. We do **not** add a new
GS0330 diagnostic at this time: every observed-in-the-wild
candidate-set has been resolvable with the filter + specificity
pair, and adding a separate code would force callers to handle two
near-identical errors. If a constraint-only ambiguity surfaces in
the wild that benefits from a tailored message, it will be
introduced under a follow-up issue.

## Migration

This ADR's binder change unblocks the L1 migration documented in
ADR-0084. As part of this PR:

- `Gsharp.Extensions.Optional.OptionalValueExtensions` is **deleted**.
  Its seven helpers (`MapValue`, `FlatMapValue`, `OrElseValue`,
  `OrComputeValue`, `OrThrowValue`, `IfPresentValue`, `FilterValue`)
  have moved into `OptionalExtensions` as `where T : struct`
  overloads of the existing `Map` / `FlatMap` / `OrElse` /
  `OrCompute` / `OrThrow` / `IfPresent` / `Filter` names. The two
  overload sets coexist inside one class because the `T?` receiver
  shape differs at the IL level (`T` for reference types,
  `Nullable<T>` for value types), so C# CS0111 is happy.
- `Gsharp.Extensions.Sequences.SequenceExtensions.FirstValueOrNil`,
  `LastValueOrNil`, `SingleValueOrNil` are renamed `FirstOrNil` /
  `LastOrNil` / `SingleOrNil` (same name as the reference-typed
  overloads) and moved to a sibling class
  `SequenceValueExtensions`. The split into two classes is
  required only because the parameter shape for sequence terminals
  is `IEnumerable<T>` — identical at the IL level regardless of
  whether `T` is a reference or value type — and C# CS0111 forbids
  two methods with identical parameter signatures in one class
  even when their constraints are disjoint. The G# binder sees both
  classes as candidate sources and resolves the call by constraint.
- Sample sources, the standard-library docs page, and ADR-0084's
  "Known limitations" section are updated to the single-name surface.

## Consequences

- **Positive — collapsed Extensions surface.** The 14-method
  `Map`/`MapValue`-style duplication in `Gsharp.Extensions.Optional`
  is gone. Callers write `value.Map(f)` regardless of whether
  `value` is `string?` or `int?`. The binder picks the right
  overload.
- **Positive — closes a class of latent IL-verification failures.**
  Any third-party assembly that ships disjoint-constraint
  extension overloads (e.g. an Option / Either library translated
  from F#) now binds correctly under G# without the user having to
  shim the names.
- **Positive — predictable algorithm.** Filter-then-specificity is
  exactly the model C# uses; G# users coming from a C# background
  see no surprises.
- **Neutral — no new diagnostics.** Ambiguity still reports via
  `GS0160`. The message text already includes candidate
  signatures, which is enough to diagnose the constraint-disjoint
  case in practice.
- **Negative — one extra type-walk per generic candidate.**
  `GetGenericParameterConstraints()` + a per-parameter loop costs
  ~O(rank × k) for `k` type parameters; in practice `k` ≤ 2 and the
  binder is already O(rank × params) so the constant factor is
  small and unmeasurable in the existing benchmarks.

## Alternatives considered

- **Match C# verbatim.** C# inspects constraints both during applicability
  and during specificity, and additionally treats certain constraints as
  signature-affecting. We adopted the applicability piece exactly. We did
  not adopt the "constraint participates in signature" rule because that
  would require a much larger overhaul of the binder's signature-keying
  and is not motivated by any observed callsite.
- **New diagnostic GS0330 for constraint-disjoint ambiguity.** Rejected
  for now — every observed case is unambiguous after the filter +
  specificity tie-break. If a real-world callsite hits this, we'll add a
  tailored code under its own issue with a concrete repro to anchor the
  message.
- **Force the user to write explicit type arguments at the call site.**
  Rejected — it would defeat the purpose of the collapse: callers would
  write `value.Map<int, int>(f)` to disambiguate, which is uglier than
  `value.MapValue(f)`.
