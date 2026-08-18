# ADR-0160: The `as` operator yields a nullable type

- **Status**: Accepted
- **Date**: 2026-08-11
- **Phase**: Phase 9 — language depth / null-handling ergonomics
- **Related**: ADR-0001 (nullable reference types), ADR-0069 (smart-cast flow narrowing), ADR-0071 (`if let` / `guard let`), ADR-0141 (expression-tree lambda conversions), ADR-0167 (checked reference conversion calls), issue [#3349](https://github.com/DavidObando/gsharp/issues/3349), parent [#3347](https://github.com/DavidObando/gsharp/issues/3347)

## Context

`as` is G#'s *testing* conversion: it yields the converted value when the runtime
type matches, and `nil` when it does not. `BindAsExpression` already enforced the
half of that contract that constrains the target:

```csharp
// Per C# §11.11.10: the `as` operator requires that the target type be
// either a reference type or a nullable value type. A non-nullable value
// type target is illegal because `as` must be able to yield null on failure.
```

But it then typed the result as the written target type — `x as string` was
`string`, not `string?`. The operator was documented as nil-producing and typed
as though it were not.

Two concrete consequences:

1. **Unsafe code bound cleanly.** `let s string = o as string` was accepted, quietly
   putting a possibly-nil value into a non-nullable local. Every later read of `s`
   was then trusted by the binder.

2. **The idiomatic narrowing form was rejected.** ADR-0071's `if let` / `guard let`
   require a nullable right-hand side so the binding has something to strip. Because
   `as` looked non-nullable, the natural spelling failed:

   ```gs
   if let s = x as string { … }
   // GS0296: The right-hand side of 'if let'/'guard let' binding 's' must be of
   //         nullable type, but its type is 'string'.
   ```

   An explicit annotation did not help — `if let s string? = x as string` reports the
   same error, because the diagnostic keys off the initializer's type.

(2) is what surfaced this. The cs2gs migration tool (ADR-0115) must translate C#'s
`if (x.Y is T t)`, and the canonical G# rendering is an `if let`. With `as`
non-nullable it could not use one, and fell back to spilling the scrutinee into a
synthetic `let __spillN` temp — destroying the author's binder name and adding a
brace level. Issue #3347 measured that shape at roughly 44 occurrences per 100k
lines in dotnet/roslyn and 186 per 100k in this repository.

## Decision

**`x as T` has type `T?`.**

ADR-0167 later added the distinct checked spelling `T(x)` / `T?(x)`.
Those forms preserve null and throw `InvalidCastException` for an incompatible
non-null value; they do not change this ADR's testing-conversion contract.

1. **Binder.** `BindAsExpression` wraps the bound target type in a
   `NullableTypeSymbol` unless it already is one, so `x as T` is `T?` and
   `x as T?` stays `T?` rather than being double-wrapped. The existing rejection of
   a non-nullable value-type target is unchanged and now reads consistently with the
   result type.

2. **`if let` / `guard let` need no special case.** They already accept any nullable
   initializer, so `if let s = x as T { … }` starts working as a consequence of (1)
   rather than through a carve-out in `IfLetBindingSupport`.

3. **Expression trees.** `!!` was unconditionally rejected inside an
   expression-tree lambda (GS0473). With (1) that made a downcast *unwritable*
   there: narrowing an `as` result requires `!!`, and no other spelling exists.
   The restriction is narrowed to what it was really protecting against — stripping
   a nullable **value** type, which is a genuine CLR conversion
   (`Nullable<T>.Value`) with no `System.Linq.Expressions` counterpart that
   preserves G#'s throw-on-nil contract. Over a **reference** type `!!` is pure
   static annotation: the CLR has no distinct `T?`, and
   `Expression.TypeAs(x, T).Type` is already `T`. `ExpressionTreeLowerer` therefore
   erases a reference-type null-assertion and passes the operand's tree through
   unchanged. An unconstrained type parameter is treated conservatively as a value
   type, since it may be instantiated with one.

## Consequences

### Newly rejected — and correctly so

```gs
let s string = o as string     // GS0155: Cannot convert type 'string?' to 'string'
```

This is the point of the change. The fix at each site is one of:

```gs
let s string? = o as string    // keep it nullable
let s = (o as string)!!        // assert, when a prior test guarantees it
if let s = o as string { … }   // narrow and bind — preferred
```

### Newly accepted

```gs
if let s = x as string { … }        // ADR-0071 narrowing over a testing conversion
guard let s = x as string else { … }
(value as string)!!.Length          // inside an expression-tree lambda
```

### Emit

Two emit paths (`SlotPlanner.IsReferenceTypeParameterCoalesceProbe` and its
`MethodBodyEmitter.Operators` counterpart, both from issue #1516) exist specifically
because `x as T ?? fallback` produced a **bare** `TypeParameterSymbol` LHS rather
than a `NullableTypeSymbol`. With `as` now yielding `T?`, that shape routes through
the pre-existing issue-#831 `NullableTypeSymbol(TP)` probe instead. The #1516 paths
are left in place: they are still reachable for a bare type-parameter LHS arising
any other way, and removing them is a separate cleanup with its own risk.

### Migration

`as` is not common in G# source. The in-repo sweep touched three test fixtures, all
of which were performing exactly the unsafe pattern this ADR outlaws — casting an
attribute out of a reflection array into a non-nullable local after a name check.

## Alternatives considered

- **Special-case `as` on an `if let` right-hand side.** Surgical, zero breakage, and
  it would have closed the reported symptom. Rejected because it treats the symptom:
  `let s string = o as string` would remain legal and remain unsafe, and every future
  construct that consumes a nullable would need the same carve-out.

- **Leave `as` alone and add a distinct nil-producing operator.** Rejected as
  gratuitous divergence from C# and Kotlin (`as?`), and it would leave two operators
  where one suffices — G#'s `as` already *behaves* the way this ADR types it.

- **Type `as T` as `T?` but keep GS0473 absolute.** Rejected: it makes a downcast
  unwritable inside an expression-tree lambda, trading one gap for another.
