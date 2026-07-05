# ADR-0141: lambda conversions to `Expression[TDelegate]`

- **Status**: Accepted
- **Date**: 2026-07-05
- **Phase**: Phase 9 — language depth / CLR interop
- **Related**: issue [#2130](https://github.com/DavidObando/gsharp/issues/2130)

## Context

G# already supported lambda/func literals targeting delegates and native
function types, but it treated `System.Linq.Expressions.Expression[TDelegate]`
like any other imported generic type. As a result, assignments and call-site
arguments such as:

```gsharp
let selector Expression[Func[Book, int32]] = (b Book) -> b.Id
```

failed with GS0155 / GS0154 instead of producing a runtime expression tree.
That blocked common .NET APIs whose surface is expression-tree based, including
Entity Framework Core fluent mapping APIs (issue #2130).

The compiler also had no expression-tree lowering path at all: no binder
recognition, no legality checks, and no emit-time construction of
`System.Linq.Expressions.Expression.*` nodes.

## Decision

Treat `Expression[TDelegate]` as a first-class lambda target when:

1. the outer type is `System.Linq.Expressions.Expression\`1`, and
2. `TDelegate` is delegate-like (native function type, imported CLR delegate,
   or user-declared named delegate).

The implementation has three parts:

### 1. Target recognition and conversion binding

`MemberLookup` now exposes a single “lambda target shape” probe that accepts:

- G# function types
- named delegates
- imported CLR delegates
- `Expression[TDelegate]`

`ConversionClassifier` uses that probe so a lambda may bind to an
expression-tree target anywhere ordinary implicit argument/assignment
conversions run: local declarations, assignments, returns, and call arguments.

Invalid `Expression[T]` targets report:

| Code   | Message summary |
| ------ | ---------------- |
| GS0474 | `Expression[T]` requires `T` to be a delegate type. |

### 2. Expression-tree restriction validation

Before lowering, the compiler walks the already-bound lambda body and rejects
constructs that do not have a safe `System.Linq.Expressions` representation in
this compiler/runtime surface.

The shared diagnostic is:

| Code   | Message summary |
| ------ | ---------------- |
| GS0473 | Unsupported construct inside an expression-tree lambda. |

The validator currently accepts the expression forms the lowerer can faithfully
materialize and rejects the rest explicitly instead of silently compiling the
wrong program.

Supported inside an expression-tree lambda:

- parameters and captured locals
- literal/default/`typeof`
- field and property access (instance/static)
- imported and user member calls
- indexers and array indexing
- unary and binary operators with an expression-factory equivalent
- conditional `?:`
- null coalescing `??`
- reference / numeric conversions
- `is` type tests and `as`
- object construction and array creation
- nested lambda values when a runtime expression/delegate object is required

Explicitly rejected with GS0473:

- statement-bodied lambdas
- async / `await`
- assignment expressions
- tuple literals / tuple assignment shapes
- switch expressions and unsupported pattern forms
- throw expressions
- null-propagation
- discards
- local functions
- `dynamic`
- unsupported by-ref / pointer / unsafe shapes
- collection/map literals and other constructs without a stable expression-tree
  lowering in this compiler

### 3. Emit-time lowering

A dedicated lowering pass rewrites lambda-to-`Expression[TDelegate]`
conversions into bound calls to `System.Linq.Expressions.Expression` factory
methods. The lowered shape is equivalent to:

1. allocate `ParameterExpression` locals for lambda parameters
2. translate the bound body into `Expression.*` nodes
3. call `Expression.Lambda(...)`
4. cast the resulting `LambdaExpression` to the exact target
   `Expression[TDelegate]`

The lowerer runs after closure boxing so captured locals reuse the existing
capture analysis. A captured variable is represented by building the runtime
capture access first, then embedding that value into the tree through
`Expression.Constant(...)` and normal member-access factories. This matches the
existing closure representation instead of inventing a second capture model.

Call-site conversions were also updated so a direct lambda argument can bind to
an `Expression[TDelegate]` parameter the same way a direct delegate argument
already could.

## Consequences

- Positive: G# lambdas can now flow into expression-tree APIs, including the
  direct call/assignment shapes needed by issue #2130.
- Positive: unsupported constructs fail early with dedicated diagnostics rather
  than later with GS0155 or, worse, a malformed tree.
- Positive: closure handling reuses the existing capture pipeline, so
  expression-tree lambdas observe the same captured values as delegate lambdas.
- Negative: the restriction set is intentionally conservative where the current
  runtime/lowering surface lacks a verified representation; unsupported syntax
  is rejected instead of partially lowered.

## Alternatives considered

- **Treat `Expression[TDelegate]` as just another imported generic and rely on
  user-written factory calls.** Rejected: it does not support idiomatic .NET
  APIs and leaves ordinary lambda syntax unusable for a large slice of the
  ecosystem.
- **Lower expression trees directly in the emitter without a dedicated pass.**
  Rejected: the conversion needs whole-expression rewriting, legality checks,
  and closure-aware synthesis before ordinary IL emission.
- **Invent separate capture analysis for expression-tree lambdas.** Rejected:
  the compiler already knows how to box and access captured locals; duplicating
  that logic would drift quickly and risk semantic mismatches.
