# ADR-0037: Numeric "better conversion target" tie-breaking in overload resolution

- **Status**: Accepted
- **Date**: 2026 (this PR)
- **Phase**: Stream F (post-PR refinement) — closes the numeric-ranking follow-up tracked in ADR-0034
- **Related**: ADR-0034 (imported CLR interop — shared `OverloadResolution` introduction)

## Context

ADR-0034 introduced the shared `OverloadResolution.Resolve` used by CLR constructor calls, imported static/instance method calls, operators, and conversions. Its tie-breaker classifies each argument-to-parameter conversion into a small ordinal enum (`Identity` < `NumericWidening` < `Reference` < `Boxing` < `NullableWrap` < `UserDefinedImplicit`) and applies C# §7.5.3.2 "better function member" on the per-argument vector.

That ordering was deliberately coarse and left two cases unresolved:

1. **Two widenings to different numeric targets.** Calling an overload set like `M(long)` vs `M(float)` with an `int` argument: both classify as `NumericWidening`, both win on no axis, and the resolver fell through to ambiguity even though C# §7.5.3.4 unambiguously prefers `long` (the smaller / closer target with an implicit conversion to `float`).
2. **Signed vs. unsigned siblings.** Calling `M(int)` vs `M(uint)` from a `short` argument: neither target implicitly converts to the other; the spec's signed-vs-unsigned subclause picks the signed one, but the resolver had no rule to apply.

The original ADR explicitly tracked this as a follow-up.

## Decision

Extend the better-function-member pass with a per-argument tie-break that activates when two candidates classify identically as `NumericWidening`. The new comparator implements C# §7.5.3.4 "Better conversion target":

- A target T1 beats T2 if an implicit conversion T1 → T2 exists and none exists T2 → T1 (T1 is the "smaller" target).
- Otherwise, if T1 is signed integral and T2 is the corresponding unsigned integral peer, T1 wins. The signed-beats-unsigned pairs follow the C# spec table (`sbyte` beats `byte`/`ushort`/`uint`/`ulong`; `short` beats `ushort`/`uint`/`ulong`; `int` beats `uint`/`ulong`; `long` beats `ulong`).
- Otherwise the two targets tie; the surrounding resolver falls through to the existing "more specific parameter" pass, then reports an ambiguity diagnostic.

The comparator is exposed publicly as `OverloadResolution.CompareNumericTargets(t1, t2, source)` returning `<0`, `0`, `>0` to allow direct unit testing and reuse.

Conversion-kind ordering itself is unchanged — identity still beats widening, widening still beats boxing, and so on — so this change cannot make a previously-resolved call ambiguous or pick a different best candidate when an identity match exists.

## Consequences

- `Math.Min(intValue, intValue)` now resolves uniquely to `Math.Min(int, int)` as before (identity beats widening), and overload sets that previously tied on widening targets — for example a hypothetical `M(long)` / `M(float)` set called with an `int` — now resolve to the smaller target.
- Code that was previously reported as ambiguous and now binds will compile silently. We accept this as a strict improvement: the new choice matches what `csc` would pick.
- The signed-vs-unsigned rule keeps GSharp source aligned with C# semantics when a library exposes parallel `int` / `uint` overloads, which is common in interop surfaces (`Span<T>` slicing, hashing APIs).

## Alternatives considered

- **Full C# §7.5.3.5 "better conversion from expression" rules including literal-zero handling.** Deferred. GSharp's binder does not yet model literal-typed arguments distinctly enough to drive the spec's expression-aware rules; the §7.5.3.4 target-only rule covers the high-value cases.
- **Generalize the comparator to all conversion kinds (e.g. reference upcasts ranked by depth in the inheritance chain).** Deferred to the next follow-up; the existing `IsAtLeastAsSpecific` pass already breaks the common reference-upcast ties and the immediate spec-conformance gap was numeric.

## Follow-ups

- Generic-method overload resolution for imported open-generic methods (`Enumerable.Select<T,R>`) still requires explicit type arguments. Tracked separately.
- `op_True` / `op_False` short-circuit for `&&` / `||` against imports.
