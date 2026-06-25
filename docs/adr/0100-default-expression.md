# ADR-0100: `default(T)` and target-typed bare `default` expression

- **Status**: Accepted
- **Date**: 2026-07-08
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #795 (G# has no way to spell the default value of a generic type parameter)
- **Related**: Parent #706 (G# Language — Current State and Design Opportunities); #792 (dogfooded `Optional`/`Sequences` port); ADR-0081 (`nil` literal); ADR-0087 (reified generics — `MVar`/`initobj` for unconstrained `T`); ADR-0097 (`class`/`struct`/`new` type-parameter constraints)

## Context

Generic G# functions had no way to spell the default value of an
unconstrained type parameter. C# uses `default(T)` or the bare `default`
literal in target-typed positions; G# had neither. The lexer already
recognised `default` as a keyword (used as the switch-arm leader) but
the parser did not treat it as an expression, so

```gs
func MakeZero[T]() T {
    return default(T)   // GS0005: Unexpected token <Default>...
}
```

failed at parse time. Without `default(T)`, the only way to obtain the
zero value of an unconstrained `T` was an indirect dance through `var x
T` (a bare variable declaration that already leans on the same emit
machinery this ADR exposes directly to user code). That works for
locals but cannot express `return default(T)`, `default(T)` as a call
argument, or `default(T)` in a conditional branch — and it is opaque to
anyone reading the source.

The blocker bites hardest in the dogfooded port of the standard library
helpers `Optional[T]` and `Sequences[T]` (#792), where every constructor
and every accessor that yields "no value" needs to be able to spell the
default of its element type parameter.

## Decision

Both forms are added; both are additive and behave the same as in C#:

1. **`default(T)`** — a primary expression valid for any type
   expression `T`. Its value is the zero-initialised value of `T`:
   `0` / `false` / `0.0` for built-in value types; `nil` for reference
   types; `nil` for `T?`; field-wise zero-initialised for user structs;
   and for an unconstrained type parameter `T`, whatever the runtime
   substitution produces (`0` if `T = int32`, `nil` if `T = string`).
2. **Bare `default`** — a literal that takes its type from the
   surrounding *target-typed* position. The four target-typed positions
   are:
   - the initializer of `let`/`var` with an explicit type clause
     (`let x int32 = default`);
   - the value of a `return` statement when the enclosing function has
     a known declared return type (`return default`);
   - an argument to a parameter of known type (`f(default)`);
   - a branch of a conditional expression whose type is supplied by
     its sibling (`true ? 42 : default`).

The arm-leader use of `default` inside `switch`/`select` is unchanged.
The parse is context-dependent: arm leaders are recognised before
expression parsing is attempted, so a bare `default` token at the start
of an arm is always read as the arm leader and never as a `default`
expression.

### Diagnostic

A new diagnostic `GS0362` (`ReportBareDefaultNoTargetType`) fires when
a bare `default` literal is used in a position from which a target type
cannot be inferred — for example `var x = default` (no type clause and
no initializer to read a type off) or `Console.WriteLine(default)`
against an unresolved overload. The error reads:

> The bare `default` literal can only be used where its type is known
> from context. Use `default(T)` to spell the default value of an
> explicit type.

### Interaction with reified generics (ADR-0087)

The IL emission for `default(T)` already existed because
`MethodBodyPlanner.CollectDefaultExpressions` pre-allocates a slot for
every value-type and type-parameter `BoundDefaultExpression` produced
by the existing `var x T` lowering and the optional-parameter machinery.
`MethodBodyEmitter.EmitDefault` emits:

- `ldnull` for a reference-type `T`;
- `ldloca <slot>; initobj T; ldloc <slot>` for a value-type `T`;
- `ldloca <slot>; initobj T; ldloc <slot>` for an unconstrained type
  parameter `T` (treated as `MVar` per ADR-0087 §3), so the substituted
  type at runtime drives the zero-initialisation correctly without a
  separate codepath.

This is exactly the IL pattern C# emits for `default(T)`. The
ilverify-clean property is preserved for the new sample
`samples/DefaultExpression.gs` and for every new emit test under
`test/Core.Tests/CodeAnalysis/Emit/Issue795DefaultExpressionEmitTests.cs`.

### Interpreter / emitter alignment for reference-type defaults

Prior to this change, the tree-walking interpreter's
`Evaluator.DefaultValue(typeof(string))` returned the Go-style
`string.Empty` ("") even though the emitted IL produced `ldnull`. ADR-0100
mandates the C# semantics across both backends. `EvaluateDefaultExpression`
now returns `null` for any non-value-type CLR type, matching the emitter.
One legacy unit test (`BareVariableDeclarationTests.BareVarDeclaration_String_DefaultsToEmpty`)
was renamed to `BareVarDeclaration_String_DefaultsToNil` to capture the
corrected behaviour.

### Binder placement of the bare-default placeholder

The bare form binds at the use site to a `BoundDefaultExpression`
carrying `TypeSymbol.Error` as a *placeholder*. Each target-typed
conversion site recognises the placeholder and rewrites it to a
fully-typed `BoundDefaultExpression` against the target type. This
composes naturally with the bind-then-convert pipeline used everywhere
(variable initialisers, return statements, conditional branches, call
arguments). If no target-typed conversion site materialises the
placeholder before the diagnostic phase runs, `GS0362` fires.

## Consequences

### Positive

- Generic helpers (`Optional[T]`, `Sequences[T]`, every user-defined
  algorithm) can now spell the zero value of their type parameters. The
  dogfooded standard-library port (#792) unblocks.
- `default(T)` is C#-compatible at the source level, so existing C#
  reference samples and tutorials port verbatim.
- Bare `default` works in every position that already infers types from
  context — no new "type-target" machinery was needed; the conversion
  chokepoint that already classifies `nil → T?`, `T → T?`,
  interpolated-string → `IFormattable`, etc. now also handles the
  placeholder.

### Negative / trade-offs

- The placeholder approach is a special-case in
  `ConversionClassifier.BindConversion` and a small per-site rewrite in
  `OverloadResolver`. It avoids a sentinel `TypeSymbol.DefaultLiteral`
  and the attendant cascade of conversion-table entries, but it is the
  one place a maintainer must remember to plumb `default` through if a
  new target-typed conversion site is added.
- Reference-type interpreter parity is a behaviour change for any user
  who was relying on `default(string) == ""`. The ADR explicitly
  reverses this; the matching test was updated.

### Out of scope

- Bare `default` inside object/collection initialisers (`new Foo{ x = default }`)
  is technically a target-typed position too, but this ADR only wires up
  the four listed positions. A follow-up ADR can extend the placeholder
  rewrite to those sites if user demand surfaces.

## Test coverage

- `test/Core.Tests/CodeAnalysis/Syntax/Issue795DefaultExpressionParserTests.cs`
  — parser tests for `default(T)` and bare `default` in every target-typed
  position, plus regression guards for the switch-arm parse.
- `test/Core.Tests/CodeAnalysis/Binding/Issue795DefaultExpressionBinderTests.cs`
  — binder/interpreter tests for `default(int32)`, `default(string)`,
  `default(T?)`, `default(T)` for unconstrained / `class` / `struct` /
  `init()` constrained `T`, all four target-typed positions, and the
  GS0362 diagnostic when no target type is available.
- `test/Core.Tests/CodeAnalysis/Emit/Issue795DefaultExpressionEmitTests.cs`
  — end-to-end emit tests: each compiled assembly is loaded into a
  collectible `AssemblyLoadContext` and executed; stdout is asserted.
  Covers the generic-`T` case with both reference and value substitutions
  to prove the `initobj T` lowering.
- `samples/DefaultExpression.gs` (+ `.golden`) — conformance sample
  exercised by `SampleConformanceTests` (compile → ilverify → execute →
  golden-diff).

## References

- C# spec, *Default value expressions* (`default(T)`) and *Default
  literal expressions* (bare `default`).
- ADR-0087 — reified generics: how `MVar` and `initobj` interact with
  unconstrained type parameters.
- ADR-0081 — `nil` literal: the source-level spelling for reference
  null; `default(T)` for a reference-type `T` is equivalent to `nil`.
- Issue #795 — original report and design discussion.
- Issue #792 — dogfooded port of `Optional` / `Sequences`.
- Issue #706 — parent "current state & design opportunities" tracker.
