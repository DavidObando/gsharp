# ADR-0133: Implicit numeric promotion at call sites

- **Status**: Accepted
- **Date**: 2026-06-27
- **Phase**: Phase 8 — primitive coverage / language conformance
- **Related**: issue #1281 (this change), issue #1280 (cs2gs coercion that motivated it), ADR-0044 (numeric primitive coverage), ADR-0129 (C#-compatible numeric literal narrowing/widening), ADR-0115 (C#→G# migration tool)

## Context

G# already applies its ADR-0044 implicit lossless-widening lattice to call
arguments: an `int32` argument binds to an `int64` parameter, a `uint16` to an
`int32`, a `uint8` to a `uint32`, and so on, for both fixed-parameter functions
and generic inference of **user** functions. What it did **not** do was the C#
**implicit constant expression conversion** (C# §10.2.11) at a call site: a
constant integer argument whose value is in range of a narrower or cross-sign
parameter type. Empirically, before this change:

```gsharp
func Take(x uint16) int32 { return int32(x) }
func Main() { let r = Take(5) }   // GS0154 — rejected
```

even though `var x uint16 = 5` already compiles (ADR-0129 handles the
declaration/assignment target). The same constant argument is accepted by C#,
which applies §10.2.11 uniformly at declaration, assignment, return, **and**
argument positions.

This gap is what motivated the cs2gs translator (ADR-0115) to make these
implicit conversions explicit on every numeric argument (`CoerceNumericArgumentToConverted`,
issue #1280) under the belief that "G# performs no implicit numeric promotion
at the call site". That belief was only ever true for the constant-narrowing
case — the widening cases were already accepted — so the translator was
emitting redundant `T(x)` wraps for conversions gsc performs on its own.

## Decision

Two coordinated changes, plus documentation.

### (a) gsc — constant-expression narrowing at call sites

Extend the value-aware constant-expression conversion of ADR-0129 from
declaration/assignment targets to **argument** positions, reusing the existing
helpers so behaviour matches §10.2.11 exactly:

- `ExpressionBinder.Operators.cs`: add
  `IsImplicitConstantNarrowingArgument(BoundExpression, TypeSymbol)`. It returns
  `true` only when the parameter is an **integer** type, the argument is a
  **constant** integer expression (an integer literal, or unary `+`/`-` over one
  — `TryGetConstantIntegerValue`), and the folded value fits the parameter type
  (`TryAdaptIntegerLiteral`). `char` is **not** an §10.2.11 destination type and
  is therefore excluded (`IsIntegerType` already excludes it), matching C#.
- `OverloadResolver.cs`: add `TryBindConstantNarrowingArgument(...)`, which —
  when the predicate holds — re-materialises the argument as a literal of exactly
  the parameter type through `ConversionClassifier.BindConversion`, the same
  mechanism ADR-0129 uses at a declaration target. It is wired into the
  applicability filter (so an overload with a narrower constant-compatible
  parameter is considered *applicable*) and the five argument-binding gates:
  variadic primary constructor, constructor, explicit constructor, constructor
  chaining (`base(...)`/`this(...)`), and the main `BindCallExpression` user-func
  path.

Non-constant operands and out-of-range / negative-to-unsigned constants are
**not** adapted and still require an explicit `T(x)` cast (`GS0154`/`GS0156`),
exactly as in C#. The ADR-0044 widening lattice is **not** modified, so the
three duplicated copies of `NumericWideningTargets` (`Conversion.cs`,
`OverloadResolution.cs`, and the per-type operators in
`ExpressionBinder.Operators.cs`) remain consistent by construction — this change
only layers a value-aware narrowing rule on top of the unchanged widening path,
mirroring ADR-0129.

**Scope note — CLR methods.** The user-function/constructor path
(`OverloadResolver`) gets the rule; the separate CLR overload-resolution path
(`OverloadResolution`, C# §7.5.3) operates on CLR `Type[]` only and does not
thread constant values, so it is left unchanged. The practical gap is
negligible: BCL methods overwhelmingly expose `int`/`long` overloads, and the
one case that matters in practice — a widening argument supplied to a **generic**
CLR method — must keep an explicit conversion regardless (see (b)).

### (b) cs2gs — skip the redundant explicit conversion

`CoerceNumericArgumentToConverted` now consults a new
`GSharpAcceptsImplicitNumericArgument(ArgumentSyntax)` predicate and emits the
**bare** operand when gsc accepts the conversion on its own. The explicit `T(x)`
wrap is kept only for the residual cases gsc still needs. The skip fires when
**all** of:

1. the argument's own numeric type differs from its Roslyn `ConvertedType`
   (there is an implicit conversion to make explicit at all);
2. the argument binds to a **concrete** numeric parameter —
   `IArgumentOperation.Parameter.OriginalDefinition.Type` is a numeric primitive.
   A **type-parameter** target is excluded, because gsc's CLR generic inference
   does not unify a widening-only numeric argument (`GS0159`), so the operand
   must already carry the converted type (e.g.
   `ArgumentOutOfRangeException.ThrowIfGreaterThan(x, ushort.MaxValue)` keeps
   `int32(UInt16.MaxValue)`);
3. the conversion is either a gsc lossless **widening** (a local
   `NumericWideningTargets` table mirroring `Conversion.cs`) **or** a foldable
   integer **literal** (`IsFoldableIntegerLiteral` — a literal or unary `+`/`-`
   over one, matching gsc's call-site folding). A non-literal constant such as a
   `const` field or `ushort.MaxValue` is **not** folded by gsc, so its wrap is
   kept.

C# guarantees the value is in range for any implicit narrowing it compiled, so
when gsc folds the same literal it reaches the same accept/reject decision. The
translator only changes the **argument** path; declaration/assignment/local
coercion (`CoerceConstantToUnsigned`) is untouched.

### (c) Documentation

- `website/docs/ref/spec.md` "Numeric types": a new bullet documents the
  call-site argument conversion rules (widening of non-constant arguments,
  constant-expression narrowing/cross-sign, the explicit-cast requirement for
  non-constant narrowing, and the generic-inference exception).
- `docs/adr/0115-csharp-to-gsharp-migration-tool.md`: the §B.12 numeric-literal
  note and the OD-T2 unsigned-coercion entry are refined to reflect that gsc now
  widens/constant-narrows numeric arguments at concrete parameters; stale
  "G# has no implicit numeric promotion" blanket phrasings are corrected.

## Consequences

- `Take(5)` for a `uint16`/`uint32` parameter, `M(5)` for a `uint` parameter,
  `new T(4)` / `: base(4)` for a `uint8` parameter, etc. now compile in gsc
  without an explicit cast, matching C#.
- Out-of-range (`Take(70000)` for `uint16`), negative-to-unsigned
  (`Take(-1)`), and **non-constant** narrowing/cross-sign arguments still
  require an explicit `T(x)` cast — unchanged.
- cs2gs output for concrete-parameter numeric arguments loses the redundant
  `int32(x)` / `uint32(5)` wrap; the wrap is preserved for generic
  (type-parameter) arguments and non-literal constants. No existing cs2gs
  baseline regressed (full translator suite green).
- The widening lattice and existing IL baselines are unchanged: this rule only
  *adds* acceptance of previously-rejected constant arguments and only *removes*
  redundant translator wraps, so emit for already-valid code is unaffected (the
  sample IL conformance suite is green).

## Alternatives considered

- **Also thread constant values through the CLR overload-resolution path
  (`OverloadResolution`).** Deferred: that path is a pure CLR-`Type[]` §7.5.3
  implementation with no expression/value in hand, and the realistic benefit is
  marginal (BCL methods expose int/long overloads). Revisit only if a concrete
  CLR-call constant-narrowing gap surfaces.
- **Leave cs2gs emitting explicit wraps and only fix gsc.** Rejected: the wraps
  are now provably redundant for concrete parameters and degrade the readability
  and fidelity of migrated G#; removing them is the point of issue #1281(b).
- **Make the cs2gs skip purely widening-based (ignore constant literals).**
  Rejected: it would needlessly keep `uint32(5)`-style wraps that gsc accepts,
  leaving the most common case un-improved.

## Deferred

- CLR-method constant-expression narrowing (the `OverloadResolution` path), as
  noted above — low value, revisit on demand.
