# ADR-0072: `??=` null-coalescing compound assignment

- **Status**: Accepted; amended 2026-10-17 by [#4967](https://github.com/DavidObando/gsharp/issues/4967) (expression form)
- **Date**: 2026-06-12
- **Phase**: Phase 9 — language depth / null-handling ergonomics
- **Related**: ADR-0001 (nullable reference types), ADR-0001 (`?:` null-coalescing read, now spelled `??` per ADR-0116), parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish), this ADR [#709](https://github.com/DavidObando/gsharp/issues/709)

> **Update (ADR-0116, issue #941):** The null-coalescing **read** operator was
> respelled from `a ?: b` to `a ?? b` and the `?:` spelling was removed. Where
> this ADR shows `?:` below it now reads `??`; the `??=` compound assignment
> described here is unchanged.

> **Amendment (issue #4967, 2026-10-17): `??=` is an expression.** This ADR
> first made `??=` statement-only "to keep it parallel with `=`, `+=`, etc.,
> which are also statement-only in G#". That premise was wrong by the time it
> was checked: #3350 confirmed that `=`, every compound operator and
> `++`/`--` are already value-producing expressions, so `??=` was the only
> assignment operator without an expression form. The revised rule, which
> replaces the statement-only rule wherever this ADR states it:
>
> - `a ??= b` is an **assignment expression**, parsed in the same
>   assignment-expression pipeline as `=` and the compound operators. It is
>   right-associative (`a ??= b ??= c` is `a ??= (b ??= c)`), and `a ??= b ?? c`
>   is `a ??= (b ?? c)`, as in C#. At statement level it is an ordinary
>   expression statement whose value is discarded.
> - Its **value** is the final value of `a`: the value read when it was not
>   nil, otherwise the assigned (converted) value of `b`. The target is never
>   re-read to produce the value.
> - Its **type** is `a`'s underlying type `T` when the stored value is known
>   non-nil, that is, when `b`'s own (pre-conversion) type is non-nullable and
>   not a platform type. This is the test plain `=` uses to narrow its target
>   (#1123), and it gives the type `a ?? b` has: `int32? ??= 42` is `int32`,
>   `string? ??= "x"` is `string` and `object? ??= 42` is `object`, matching
>   C#. Otherwise the type is `a`'s `T?`: a nullable `b`, or a `T!`
>   (ADR-0186) `b`, which may be nil and is stored unchecked as the statement
>   form always stored it. A `T!` target follows the same rule
>   (`T! ??= "x"` is `string`). A right side the target types as a whole (an
>   `if`, `switch`, conditional or block expression) is typed `T?`, so the
>   result is `T?` (#4984).
> - The stored value is converted to the target once and the same value is
>   yielded, so a boxed value keeps its identity. A throwing right side
>   (`a ??= throw e`) is the coalesce's fallback as in `a ?? throw e`.
> - As with `=` (issue #2152), a lambda whose body ends in `??=` infers a
>   `void` result when no target type gives it one. This applies to a block
>   tail (`() -> { x ??= v }`) and to an expression body (`() -> x ??= v`);
>   with a target type the lambda yields the value.
> - A value-type receiver remains in its original writable storage in both
>   positions (#5005). For array elements and nested fields the shared capture
>   saves reference owners and indices, not the struct value. These ordinary
>   values may cross an awaited right side without a managed-pointer field.
>   Read-only storage and struct temporaries are rejected, as with `=`.
> - In value position the right side is evaluated into a temporary before
>   the write. So a reference-typed receiver held in a variable, and every
>   CLR indexer argument, is captured even when it is a plain variable: a
>   right side that reassigns it does not redirect the write. A value-type
>   receiver is never copied. The statement lowering does not capture these
>   yet, and a right side that reassigns them redirects or crashes it (#5000).
> - Evaluation is unchanged in both positions: the target's receiver and
>   indices are evaluated once, the target is read once, and `b` is evaluated
>   and written back only when that read is nil.
> - Narrowing is unchanged. The statement form keeps its lowering, so it keeps
>   its flow facts: it does not narrow the target after `a ??= b`, except
>   that a throwing `b` (`a ??= throw e`) leaves `a` narrowed through the
>   `if`-join rule, as before. The expression form does not narrow the target
>   (narrowing after `??=` is tracked in #4978). A `??=` inside a closure
>   still invalidates the target's narrowing in both positions.
> - cs2gs keeps translating a C# value-position `??=` through its existing
>   lowering until the pinned SDK includes this change (N-1); #4979 tracks
>   emitting the expression form.
>
> One routine (`BindNullCoalescingAssignmentOperands`) binds what both
> positions share: target validation, diagnostics and the right-hand side.
> One routine (`TryBuildNullCoalescingReadWrite`) captures the receiver and
> indices and builds the read and the write. The positions differ only in
> what follows from value position:
>
> - A statement keeps this ADR's lowering, `if read == nil { write(b) }`, so
>   unaffected statements emit byte-identical IL. The IL baseline gate
>   (`RefactoringBaselineTests`) pins this.
> - An expression uses the compound-assignment lowering shape, a
>   `BoundBlockExpression` of the captures over
>   `read ?? { let v = b; write(v); v }`. The nil test is the `??`
>   operator's own, and no new `BoundNodeKind` is introduced.
>
> One deliberate difference from `=` is recorded here: `(x = v)` has `x`'s
> declared type (`T?`), while `(x ??= v)` has `T` for a known non-nil `v`,
> because that is C#'s rule for `??=` and its value is never nil in that
> case.
>
> **Compatibility.** Except for correcting the lost struct writes in #5005
> (and rejecting writes to read-only struct storage or temporaries), existing
> programs keep their behavior: each existing `??=` is in statement position, which still parses
> (as an expression statement over the new node) and keeps its diagnostics,
> evaluation order and narrowing. The positions that now compile, such as
> `let r = (x ??= y)`, `f(x ??= y)`, `return x ??= y`, `a ??= b ??= c` and
> `x = y ??= z`, were all parse errors (`GS0005`) or `GS0299` before. The
> syntax API changes: `NullCoalescingAssignmentStatementSyntax` is replaced by
> `NullCoalescingAssignmentExpressionSyntax`, and
> `SyntaxKind.NullCoalescingAssignmentStatement` is renamed in place to
> `NullCoalescingAssignmentExpression`.

## Context

G# spells the null-coalescing **read** as `a ?? b` (originally `a ?: b`; see
ADR-0116) — `b` is returned only
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
cfg.Endpoint = cfg.Endpoint ?? "https://example.com"
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

Add `??=` as a compound assignment with these semantics (originally
statement-only; an expression since the #4967 amendment above):

> `a ??= b` desugars to *"evaluate `a`'s receiver once; if the resulting value
> is nil, evaluate `b` (also once) and write the result back through the same
> lvalue. Otherwise do nothing — `b` is not evaluated."*

### Spelling

The operator is the three-character sequence `??=` (two `?` followed by `=`).
The lexer recognizes the sequence directly. G# does **not** introduce a bare
`??` token (its null-coalescing read was `?:` at the time of this ADR; ADR-0116 later made the read itself `??`); the doubled
`?` only appears as part of `??=`. Whitespace inside the sequence is not
allowed.

### Grammar

```
NullCoalescingAssignmentExpression
    : Expression '??=' AssignmentExpression
    ;
```

(Amended by #4967: originally a statement production,
`NullCoalescingAssignmentStatement : Expression '??=' Expression`.)

The left-hand side accepts the same lvalue shapes as the simple assignment
statement:

- a writable local / parameter / package-level variable
- a writable field on a struct or class instance (`obj.Field`)
- a writable auto-property or computed property (`obj.Prop` with a setter)
- a writable CLR property or non-init-only CLR field (`obj.ClrMember`)
- an index expression (`coll[k]`, both G#-native and CLR indexers)

~~`??=` is **not** an expression — there is no value left on the stack — so it
cannot appear inside larger expressions, in argument positions, or as the
right-hand side of another assignment. This matches the existing compound
forms (`+=`, `-=`, etc.) and the bare `=` assignment statement.~~
Superseded by the #4967 amendment: `??=` is an expression and may appear in
any value position, like `=`, `+=` and `++`.

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
indexer. The binder spills reference receivers and index values into synthetic
read-only locals. A value-type receiver is instead retained as a storage
expression over captured reference owners and indices, never a struct copy.
For a reference receiver the bound shape is:

```
{
    let __ncaRecv = <receiver-expr>;
    let __ncaIdx  = <index-expr>;          // only for indexer LHS
    __ncaRecv.Member /* or [__ncaIdx] */ ?? {
        let __ncaVal = <rhs-expr>;
        __ncaRecv.Member /* [__ncaIdx] */ = __ncaVal;
        __ncaVal
    }
}
```

(Amended by #4967. This is the value-position shape. A statement keeps the
original shape, `if __ncaRecv.Member == nil { __ncaRecv.Member = <rhs-expr>; }`,
which leaves no value. The `??` form reads the target once, evaluates the
right side only on nil, and yields the final value.)

A simple value-type variable is already stable storage and needs no spill.
An interface-constrained type parameter can hold a struct or a reference.
Capture its reference value only for reference instantiations, and reconstruct
a conditional address to that snapshot or the original struct storage.
The selector and snapshot may survive suspension, but no managed pointer does.
In value position a reference-type variable is snapshotted too. Statement
position still elides capture for a simple variable of known reference type.
RHS reassignment of that variable or a CLR indexer key remains tracked
separately in #5000.

For `a[i].Inner.F ??= b`, capture `a` and `i` and rebuild the element/field
address for the read and write. This retains the original element even if
`b` reassigns `a` or `i`, runs each component once, and introduces no byref
local across an `await`. A nested value field rooted in a class similarly
captures the class reference, while a nested field rooted in a struct local
continues to refer to that local's storage.

A smart-cast struct receiver stored in an object or interface slot is
rejected with `GS0499`. Its unboxed address has controlled mutability and
cannot serve as writable struct storage.

Before capturing indexer arguments, evaluate and discard the storage receiver's
address. Null and array-bounds checks therefore precede argument side effects,
without retaining a managed pointer across suspension. CLR field chains retain
their addressability after a reference owner is captured, including across REPL
submissions; receiver emission and spill planning share that decision.
Rebuilt CLR indexer reads and writes retain their constrained receiver and
interface types, including writes through native ref aliases.

For a storage receiver, a suspending right side is computed into a value
local inside the statement's nil branch before the write. This prevents
general await operand spilling from copying the struct receiver (#5012).
An opaque ref-returning receiver is instead captured as a native ref alias;
the existing liveness analysis rejects it across an `await` (`GS0258`)
rather than re-evaluating the call or hoisting a managed pointer.

The synthetic locals follow the existing `<…>` naming convention used by the
binder for compiler-generated temporaries; they are not visible to user
code and do not collide with user-chosen identifiers.

### Bound tree

`??=` does **not** introduce a new `BoundNodeKind`. A statement desugars at
bind time into a `BoundBlockStatement` containing zero or more
`BoundVariableDeclaration` nodes followed by a single `BoundIfStatement` whose
then-branch writes the right-hand side. An expression (#4967) desugars into a
`BoundBlockExpression` (the compound-assignment lowering shape)
containing zero or more `BoundVariableDeclaration` nodes over a single
null-coalescing `BoundBinaryExpression` whose right operand is a
`BoundBlockExpression` that stores the right-hand side in a synthetic local,
writes it through the existing assignment-expression node appropriate for
the LHS shape
(`BoundAssignmentExpression`, `BoundFieldAssignmentExpression`,
`BoundPropertyAssignmentExpression`, `BoundClrPropertyAssignmentExpression`,
`BoundIndexAssignmentExpression`, or `BoundClrIndexAssignmentExpression`),
and yields the local. Both shapes use one of the existing assignment-expression
nodes for the write. This deliberately sidesteps the bound-tree-discipline overhead (rewriter,
walker, printer, spill rewriter, exhaustiveness allowlists) because the
existing lowering already handles every node it produces, and both backends
(emit and interpreter) already evaluate those nodes correctly.

Simple variable receivers keep the variable-receiver write constructors.
Reconstructed value-type storage uses the existing expression-receiver
field/index write constructors, so the emitter takes the field or element's
address rather than writing a temporary. The REPL compiles submissions through
the same emitter (ADR-0156); no legacy evaluator path is involved.

### Diagnostics

| Code     | Surface                                                                                |
|----------|----------------------------------------------------------------------------------------|
| GS0298   | The left-hand side of '??=' must be of a nullable type ('T?').                         |
| GS0299   | The left-hand side of '??=' must be an assignable variable, field, property, or indexer. |
| GS0127   | (Existing) variable is read-only and cannot be assigned to — surfaced when the LHS resolves to a readonly local, parameter, field, or non-writable property. |
| GS0029 / GS0030 | (Existing) RHS conversion errors when the value does not convert to the LHS's nullable type. |

### Out of scope

- ~~**Expression form** (`x = (y ??= z)`): not supported. This keeps `??=`
  parallel with `=`, `+=`, etc., which are also statement-only in G#.~~
  Supported since the #4967 amendment; `=` and `+=` were never
  statement-only.
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
  one-line `x = x ?? b()` form does not.

### Negative

- One more piece of syntax for users to learn (though it is well-trodden
  in adjacent languages).
- Tooling that walks the syntax tree must learn the new
  `NullCoalescingAssignmentStatementSyntax` and the matching
  `QuestionQuestionEqualsToken`.

### Neutral

- The samples / language tour gain a new example; the spec gains a small
  subsection under "Operators" and one under "Statements".
