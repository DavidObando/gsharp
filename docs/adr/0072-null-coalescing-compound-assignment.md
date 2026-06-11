# ADR-0072: `??=` null-coalescing compound assignment

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 9 — language depth / null-handling ergonomics
- **Related**: ADR-0001 (nullable reference types), ADR-0066 (`?:` null-coalescing read), parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish), this ADR [#709](https://github.com/DavidObando/gsharp/issues/709)

## Context

G# spells the null-coalescing **read** as `a ?: b` — `b` is returned only
when `a` is nil, with short-circuit semantics. There is no compound form for
the very common "assign default if currently nil" pattern, so today programmers
write the long-hand:

```gs
if cfg.Endpoint == nil {
    cfg.Endpoint = "https://example.com"
}
```

…or the read-and-write pair:

```gs
cfg.Endpoint = cfg.Endpoint ?: "https://example.com"
```

The first is verbose and easy to forget; the second re-evaluates the receiver
twice and always writes (which is observable when the right-hand side has
side effects or the receiver is a property with a setter).

C# (`a ??= b`), Kotlin (`a ?: run { a = b }`), Swift (custom operator),
JavaScript / TypeScript (`a ??= b`), Python (`a = a if a is not None else b`)
all agree the right ergonomics here is a dedicated compound assignment that
**reads the lvalue once**, **evaluates the right-hand side only when the
current value is nil**, and **writes through the lvalue once** in that case.

## Decision

Add `??=` as a **statement-only** compound assignment with these semantics:

> `a ??= b` desugars to *"evaluate `a`'s receiver once; if the resulting value
> is nil, evaluate `b` (also once) and write the result back through the same
> lvalue. Otherwise do nothing — `b` is not evaluated."*

### Spelling

The operator is the three-character sequence `??=` (two `?` followed by `=`).
The lexer recognizes the sequence directly. G# does **not** introduce a bare
`??` token (its null-coalescing read remains `?:` from ADR-0066); the doubled
`?` only appears as part of `??=`. Whitespace inside the sequence is not
allowed.

### Grammar (statement)

```
NullCoalescingAssignmentStatement
    : Expression '??=' Expression
    ;
```

The left-hand side accepts the same lvalue shapes as the simple assignment
statement:

- a writable local / parameter / package-level variable
- a writable field on a struct or class instance (`obj.Field`)
- a writable auto-property or computed property (`obj.Prop` with a setter)
- a writable CLR property or non-init-only CLR field (`obj.ClrMember`)
- an index expression (`coll[k]`, both G#-native and CLR indexers)

`??=` is **not** an expression — there is no value left on the stack — so it
cannot appear inside larger expressions, in argument positions, or as the
right-hand side of another assignment. This matches the existing compound
forms (`+=`, `-=`, etc.) and the bare `=` assignment statement.

### Typing

`??=` requires the LHS to be of a nullable type (`T?` for any `T`, both
nullable reference types and `Nullable<T>` value types). Concretely:

- The LHS type must be `NullableTypeSymbol`. A non-nullable LHS is a hard
  error: **GS0298** *"The left-hand side of '??=' must be of a nullable type
  ('T?'). The expression has type 'T'."*
- The RHS is bound with a *target type* equal to the LHS's nullable type, so
  the author can write either an underlying-typed value (which lifts through
  the implicit `T → T?` conversion) or another `T?` value. The usual
  conversion diagnostics apply.
- A non-assignable LHS (an arbitrary expression — e.g. a method call result
  or a literal) yields **GS0299** *"The left-hand side of '??=' must be an
  assignable variable, field, property, or indexer."* Where the LHS resolves
  to a readonly local, field, or non-writable property, the existing GS0127
  ("variable is read-only and cannot be assigned to") is surfaced for parity
  with the simple assignment path.

### Semantics for nullable reference vs nullable value types

Both shapes share one observable contract: *the right-hand side is evaluated
exactly when the current value is nil*. The two underlying representations
differ but the surface behavior is the same.

- **Nullable reference types** (`string?`, `Person?`, …): "is nil" is the
  literal CLR reference being `null`. The desugaring tests the read with
  the existing `==` operator binding for nullable references and writes the
  RHS through the lvalue when true. No allocation, no boxing.
- **Nullable value types** (`int32?`, `bool?`, custom `Nullable<T>`): "is nil"
  is `HasValue == false`. The existing `BoundBinaryOperator.Bind(==, T?,
  null)` already lowers to the appropriate `Nullable<T>.HasValue` check;
  `??=` reuses that same operator. When the RHS is bound to the lifted
  nullable target type, the assignment writes through the lvalue with the
  same lifting semantics as a plain `=` assignment.

In particular, on a nullable value type the read is **a single load of the
nullable struct value** (or its address for in-place tests), so the
`HasValue` probe is exactly the same as the equivalent `if x == nil`. There
is no second read in the write path.

### Receiver capture (single evaluation)

The desugaring must guarantee that the receiver and any index expressions
are evaluated **exactly once**, even when the LHS is a member access or an
indexer. The binder achieves this by spilling any non-trivial receiver (and
each index expression) into a synthetic read-only local declared in the
current scope, and emits the bound shape:

```
{
    let __ncaRecv = <receiver-expr>;
    let __ncaIdx  = <index-expr>;          // only for indexer LHS
    if __ncaRecv.Member /* or [__ncaIdx] */ == nil {
        __ncaRecv.Member /* [__ncaIdx] */ = <rhs-expr>;
    }
}
```

A receiver that is already a simple `BoundVariableExpression` (a local,
parameter, or package-level variable) needs no spill — reading it twice has
no observable side effect — so the desugaring elides the synthetic local
in that case and emits just the `if` statement.

The synthetic locals follow the existing `<…>` naming convention used by the
binder for compiler-generated temporaries; they are not visible to user
code and do not collide with user-chosen identifiers.

### Bound tree

`??=` does **not** introduce a new `BoundNodeKind`. It desugars at bind time
into a `BoundBlockStatement` containing zero or more `BoundVariableDeclaration`
nodes followed by a single `BoundIfStatement` whose then-branch is the
existing assignment-expression node appropriate for the LHS shape
(`BoundAssignmentExpression`, `BoundFieldAssignmentExpression`,
`BoundPropertyAssignmentExpression`, `BoundClrPropertyAssignmentExpression`,
`BoundIndexAssignmentExpression`, or `BoundClrIndexAssignmentExpression`).
This deliberately sidesteps the bound-tree-discipline overhead (rewriter,
walker, printer, spill rewriter, exhaustiveness allowlists) because the
existing lowering already handles every node it produces, and both backends
(emit and interpreter) already evaluate those nodes correctly.

The receiver spilled into a synthetic local is always referenced through a
`BoundVariableExpression`, so the same `BoundFieldAssignmentExpression`
constructor used by the rest of the binder applies — the
`ReceiverExpression` overload (added for closure-boxing lowering, issue
[#567](https://github.com/DavidObando/gsharp/issues/567)) is intentionally
avoided because the interpreter only reads `node.Receiver` (the
`VariableSymbol` form) for class-field writes.

### Diagnostics

| Code     | Surface                                                                                |
|----------|----------------------------------------------------------------------------------------|
| GS0298   | The left-hand side of '??=' must be of a nullable type ('T?').                         |
| GS0299   | The left-hand side of '??=' must be an assignable variable, field, property, or indexer. |
| GS0127   | (Existing) variable is read-only and cannot be assigned to — surfaced when the LHS resolves to a readonly local, parameter, field, or non-writable property. |
| GS0029 / GS0030 | (Existing) RHS conversion errors when the value does not convert to the LHS's nullable type. |

### Out of scope

- **Expression form** (`x = (y ??= z)`): not supported. This keeps `??=`
  parallel with `=`, `+=`, etc., which are also statement-only in G#.
- **`&&=` / `||=` / `?.??=`** chained forms: not in scope for this ADR.
- **Custom user-defined operator overloads** for `??=`: out of scope; the
  operator is hard-wired to the desugaring above for any `T?` LHS.
- **Reactive / volatile semantics** (e.g. `Interlocked.CompareExchange`): the
  desugaring is a plain `if`/write pair, not atomic. Concurrency-safe
  initialisers must continue to be written by hand.

## Consequences

### Positive

- Removes a recurring papercut in defaulting/lazy-init patterns.
- Matches the well-known C# spelling, lowering the learning curve.
- Reuses existing binder infrastructure (no new bound node, no new lowering
  path), so the change is small and self-contained.
- Guarantees single evaluation of receiver and RHS — a property that the
  hand-written `if x == nil { x = b() }` form already gives but that the
  one-line `x = x ?: b()` form does not.

### Negative

- One more piece of syntax for users to learn (though it is well-trodden
  in adjacent languages).
- Tooling that walks the syntax tree must learn the new
  `NullCoalescingAssignmentStatementSyntax` and the matching
  `QuestionQuestionEqualsToken`.

### Neutral

- The samples / language tour gain a new example; the spec gains a small
  subsection under "Operators" and one under "Statements".
