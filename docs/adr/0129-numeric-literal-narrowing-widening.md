# ADR-0129: C#-compatible numeric literal narrowing/widening

- **Status**: Accepted
- **Date**: 2026-06-25
- **Phase**: Phase 8 — primitive coverage / language conformance
- **Related**: issue #1183, ADR-0044 (numeric primitive coverage), ADR-0037 (numeric tie-breaking), issue #1144 (binary-operator literal adaptation), issue #1150 (directional integer widening)

## Context

G#'s numeric model (ADR-0044) defines operators per primitive type and a
widening conversion lattice. Prior to this change, the conversion classifier
(`Conversion.Classify`) was purely *type-pair* based: a conversion from one
numeric primitive to another was classified as **implicit** only when the
target appeared in the source's widening set, and **explicit** otherwise. The
classifier had no access to the *value* of a constant operand, so an in-range
constant narrowing such as

```gsharp
var x uint8 = 42      // int32 literal 42 -> uint8
var s int16 = 100
var u uint32 = 5
var a int8 = -5
```

was rejected with `GS0156` ("an explicit conversion exists"), forcing an
awkward `uint8(42)` cast for a value the compiler can prove is representable.
This diverges from C#, whose **implicit constant expression conversions**
(C# §10.2.11) permit a constant of an integer type to convert implicitly to a
narrower integer type whenever the constant value is within the target's range.

Issue #1144 had already added value-aware *literal adaptation* for binary
operators (`a + 1` with `a : uint32` binds as `uint32 + uint32`), and issue
#1150 added directional integer widening for two typed operands. Both live in
`ExpressionBinder.Operators.cs` and reuse a `TryAdaptIntegerLiteral` helper
that range-checks via `BigInteger`. The remaining gap was the *general*
conversion path used by variable declarations, assignments, returns, and
argument passing — i.e. wherever a target type is expected.

## Decision

Implement the three C# rules in G# terms:

1. **Implicit constant expression conversions (C# §10.2.11).** A *constant*
   integer expression — an integer literal, or unary `+`/`-` applied
   (recursively) to one — converts **implicitly** to any integer target type
   when its value lies within the target's range, with no cast. Out-of-range
   constants are **not** adapted and remain an error (the value is never
   silently wrapped or truncated). The folded value is re-materialised as a
   `BoundLiteralExpression` of exactly the target type so emit produces a
   correctly-typed constant (and a redundant `conv.*` is elided).

2. **Implicit widening of non-constant values.** Unchanged: a value of a
   narrower numeric type implicitly converts to a wider one per the widening
   lattice (`int32 → int64`, `int32 → float64`, `float32 → float64`, …).

3. **Explicit narrowing of non-constant values.** Unchanged: narrowing a
   non-constant value (`int64 → int32`, `float64 → int32`) requires the
   explicit conversion-call form `T(x)` and truncates toward zero like C#
   (`int32(19.75) == 19`).

### Implementation

- `ExpressionBinder.Operators.cs`:
  - Factor `TryAdaptIntegerLiteral(object, …)` into a shared
    `TryAdaptIntegerLiteral(BigInteger, …)` overload (same range table), plus a
    `ToBigInteger(object)` widener.
  - Add `TryGetConstantIntegerValue(BoundExpression, out BigInteger)` which
    folds an integer literal or a unary `+`/`-` over one into its compile-time
    value.
- `ConversionClassifier.BindConversion`: after the type-pair
  `Conversion.Classify`, when the classification is **not** already implicit,
  the target is an integer type, and the source is a constant integer
  expression whose value fits the target, return a re-typed literal directly
  (the implicit constant narrowing). Identity/widening conversions and all
  non-constant cases are untouched, so existing diagnostics and overload
  resolution are unaffected.

The widening lattice is **not** modified, so the three duplicated copies of
`NumericWideningTargets` (`Conversion.cs`, `OverloadResolution.cs`, and the
per-type operators in `ExpressionBinder.Operators.cs`) remain consistent by
construction — this change only adds a value-aware *narrowing* rule layered on
top of the unchanged type-pair lattice.

## Consequences

- `var x uint8 = 42`, `var s int16 = 100`, `var a int8 = -5`, and assignment
  `x = 200` (constant, in range) now compile without a cast, matching C#.
- Out-of-range constant narrowings (`uint8 = 300`, `uint8 = -1`,
  `int8 = -200`) still report `GS0156`.
- Non-constant narrowing (`var x uint8 = n` with `n : int32`) still requires an
  explicit `uint8(n)` cast (`GS0156`).
- Emitted IL for in-range constant narrowings drops a redundant conversion
  opcode (the literal is emitted directly as its target type); the
  `samples/FriendlyNumericAliases.gs` IL baseline was regenerated accordingly.
  Runtime values are unchanged.

## Alternatives considered

- **Extend `Conversion.Classify` to take the source expression / constant
  value.** Rejected: `Classify` is a pure type-pair function consumed by
  overload resolution and operator typing in many call sites; threading a
  value through it would risk subtle changes to those paths. Layering the
  value-aware rule in `ConversionClassifier.BindConversion` (which already has
  the bound expression in hand) confines the behaviour to where a target type
  is genuinely expected.
- **Generalise to full constant folding of arbitrary arithmetic.** Deferred:
  the issue targets literals and unary-signed literals; folding general
  constant arithmetic (`1 + 2`, `const`-propagated values) is a larger,
  separate feature. The helper is structured so it can grow later.

## Deferred

- **Bare-literal type inference for values exceeding `int32` range.** A bare
  decimal integer literal larger than `int32` (e.g. `4294967295`) is still
  rejected by the lexer (`GS0004 "isn't valid int32"`) before binding, so
  `var u uint32 = 4294967295` does not compile without a suffix. C#-style
  integer-literal type inference (§6.4.5.3, where such a literal is typed as
  `uint`/`long`/`ulong` automatically) is a distinct lexer-level feature and is
  out of scope for issue #1183.
