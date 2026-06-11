# ADR-0069: Kotlin-style smart cast (flow-sensitive narrowing on `is` / `!is`)

- **Status**: Accepted
- **Date**: 2026-06-11
- **Phase**: Phase 9 — language depth / flow analysis
- **Related**: ADR-0001 (nullable reference types), ADR-0017 (method virtuality / `open`), ADR-0067 (fields require `var`/`let`), issues [#575](https://github.com/DavidObando/gsharp/issues/575) (expression-level `is`/`as`), [#208](https://github.com/DavidObando/gsharp/issues/208) (`[MemberNotNull]` post-condition narrowing), and [#700](https://github.com/DavidObando/gsharp/issues/700)

## Context

Issue #575 gave G# an expression-level `is` operator that returns `bool` (`expr is T`). The operator does the runtime type test correctly, but it does not change what the binder *thinks* the operand's type is. A user who writes the Kotlin / Swift / TypeScript idiom

```gs
let a Animal = Dog()
if a is Dog {
    a.Bark()        // Bark only exists on Dog — GS0159 today
}
```

gets `GS0159 Cannot find function Bark` even though the `is` check has already proven that `a` is a `Dog` at runtime. The only available workarounds are to write an explicit `as`-cast and assign the result to a new local (`let d = a as Dog; d.Bark()`), or to destructure through a `switch` pattern arm (`switch a { case d is Dog { d.Bark() } }`). Both add ceremony for the most common type-test shape.

The binder already carries the infrastructure that this feature needs. Issue #208 introduced a stack of narrowing frames (`BinderContext.NarrowedVariables`) keyed by `VariableSymbol`, with mutation-driven invalidation in `BindBlockStatements`. `BindIfStatement` consults `TryClassifyNilGuard` and `TryClassifyBoolCallNarrowing` to push a per-branch narrowing frame around the then- and else-arms. `BoundVariableExpression` carries an optional `NarrowedType` that overrides `Variable.Type` for downstream binding decisions (member lookup, overload resolution, conversion). The work for this feature is therefore plumbing — extend the existing classifier to recognise `is` and `!is` (and chains thereof), wire the resulting frame to subsequent statements when the original branch ends in an early exit, and emit a single `castclass` / `unbox.any` on the read site so the IL stack matches the narrowed type.

Kotlin's well-documented rules for `is` smart casts give us a precedent that matches G#'s ownership and aliasing model very closely: narrowing applies to `val` (analogous to G# `let`), it applies to `var` (G# `var`) only when the binder can prove the variable was not reassigned or captured between the test and the use, and it never applies to public mutable properties (since another thread could change them between the test and the use). G# inherits exactly that contract.

## Decision

A successful `is` (or `!is`) test against a local-variable or parameter receiver makes the binder treat that variable as the tested type for the rest of the enclosing flow region.

### Positive narrowing on `is`

In the then-branch of `if x is T { … }`, occurrences of `x` bind at type `T` instead of the declared type. Member lookup, overload resolution, conversion, and emit all see `T`.

```gs
let a Animal = Dog()
if a is Dog {
    a.Bark()        // accepted — `a` is `Dog` in this branch
}
```

The same rule applies when the test is the sole condition of a switch arm pattern (already covered by ADR-0001 §pattern-narrowing), and when the test feeds the left operand of a logical-and chain (see *Combinations* below).

### Negative narrowing on `!is` with early exit

G# also accepts the Swift / TypeScript "guard-clause" shape: a `!is` test whose then-branch exits the enclosing block lifts the narrowing into the rest of that block.

```gs
func Speak(a Animal) {
    if a !is Dog { return }
    a.Bark()        // accepted — `a` is `Dog` in the rest of the function body
}
```

The narrowing is pushed onto the enclosing block's persistent narrowing frame exactly when the then-branch terminates via `return`, `throw`, `break`, `continue`, or unconditionally branches out (a block whose last statement does any of those). Any other shape (the then-branch falls through, contains a conditional return, etc.) does not narrow because the compiler cannot prove the post-condition.

To match the Kotlin surface verbatim, G# parses `!is` as a contextual two-token sequence (`!` followed immediately by `is`) at the relational-operator tier and lowers it to `!(x is T)`. Both shapes — `if a !is Dog { … }` and `if !(a is Dog) { … }` — produce the same bound tree and therefore enjoy the same narrowing.

### Combinations

`&&` (logical and) threads the left operand's narrowing into the right operand. In `x is T && f(x)`, `f(x)` binds with `x` narrowed to `T`. The combined frame then becomes the then-branch frame:

```gs
if a is Dog && a.Name != "" {
    a.Bark()        // narrowed
}
```

`||` (logical or) intentionally does **not** narrow inside either branch. In `if (x is T || x is U) { … }` the variable could be `T`, `U`, or neither at the use site, so binding `x` at one specific narrower type would be unsound. This is the same rule Kotlin enforces.

Negation flips which branch sees the narrowing: `!(x is T)` adds the `T` narrowing to the *else*-branch frame, not the then-branch. The early-exit lift described above is precisely the case where the negated test, combined with an early-exit then-branch, surfaces the original `is T` narrowing in the rest of the enclosing block.

### Where narrowing applies

Only locals and parameters (`LocalVariableSymbol`, `ParameterSymbol`) are narrowed. Public properties, instance fields read through an explicit `this.` receiver, fields accessed through any other receiver, and array / index expressions are never narrowed — they may change between the test and the use under aliasing or another thread.

Implicit-field reads (`_name` resolving to `this._name`) are already separately handled by the `[MemberNotNull]` machinery from issue #208 and are not extended by this ADR.

### Invalidation rules

The narrowing is dropped under any of these conditions, all of which already had infrastructure in place for the nullable-narrowing case:

- **Reassignment**: an assignment to the narrowed variable inside the narrowed region drops the narrowing for that variable from every active frame (`InvalidateNarrowingsForAssignedVariables`). The narrowing is *not* restored after the assignment — Kotlin's same rule.
- **Closure capture**: when the narrowed region contains a lambda or local-function literal that captures the narrowed variable, the narrowing is dropped before binding the lambda body and is restored once binding leaves the lambda. The capturing closure binds the variable at its declared type, so the closure body sees the original type even if the surrounding scope was narrowed.
- **`var` with a structural risk of mutation**: for an immutable binding (`let` local, primary-ctor parameter passed by value, etc.) the narrowing is unconditional. For a mutable binding (`var` local) the narrowing applies but is dropped the first time the binder sees an assignment to that variable inside the narrowed region. This is the same conservative rule that nullable narrowing already uses.

### Combination with the existing nullable-narrowing path

Both `is` narrowing and nil-guard narrowing produce frames keyed by `VariableSymbol → TypeSymbol`. They compose naturally: `if a != nil && a is Dog { a.Bark() }` narrows `a` first to its non-nullable underlying type (then frame from `!= nil`) and then to `Dog` (then frame from `is Dog`). The lookup in `TryGetNarrowedType` walks the frame stack innermost first, so the innermost (more specific) narrowing wins.

## Considered alternatives

- **`as`-cast and rebind to a new local** — the existing workaround. Rejected because it bloats every type-test site with a new identifier; Kotlin, Swift, and TypeScript all chose flow-narrowing over rebinding for exactly this reason. The `as` operator stays available for the cases where rebinding *is* desired.
- **Pattern-binding syntax (`if let dog = a as Dog { … }` à la Swift)** — would require new syntax and a new bound-tree node; gives the user nothing that `is` + smart-cast doesn't already give them.
- **C# `is`-with-declaration syntax (`if (a is Dog d) { d.Bark() }`)** — the closest alternative; the C# compiler models `d` as a separate local with type `Dog` rather than narrowing the original `a`. Rejected because it requires new pattern syntax (`is T <ident>`), and because Kotlin's approach composes better with `&&` chains, early-exit lifts, and the existing G# `is` expression.
- **No support; require explicit `as`** — rejected per the issue request.
- **Narrow through fields and properties** — rejected for the same reason Kotlin rejects it: a field or property read is not idempotent (another thread or a `deinit` could change it), so narrowing across two reads is unsound. The `[MemberNotNull]` post-condition machinery (issue #208) covers the safe sub-cases.
- **Narrow `var` unconditionally** — rejected. A mutable local may be reassigned between the test and the use; narrowing past the reassignment would be unsound. The conservative rule (narrow until the first observed write) matches Kotlin and TypeScript.

## Migration impact

Purely additive. Existing programs continue to bind and emit identically: a program that today calls `a.Bark()` after `if a is Dog { … }` was rejected by the binder, so adopting the new narrowing rule can only widen the accepted-program set, never narrow it. Existing user workarounds (explicit `as`-casts to a new local) continue to compile and execute exactly as before.

Two syntactic additions are introduced — both contextual and both unambiguous:

- `!is` as a relational operator (`x !is T`). This is recognised as the two-token sequence `BangToken` immediately followed by `IsKeyword`. The `!` here was already legal as a leading unary operator on an `is` expression (`!(x is T)`), so no existing program parses differently after the change.
- The smart-cast narrowing itself is the additive behaviour described above.

No new diagnostic is introduced. The previously-emitted `GS0159` (member-not-found on the broader type) simply stops firing inside a properly-guarded region.

## Implementation notes

- **Syntax** (Parser only — no new node kinds). `Parser.ParseBinaryExpression` already recognises the `is` keyword at relational precedence (tier 3). The same dispatch is extended: when the current token is `BangToken` and the next token is `IsKeyword`, the parser consumes both, parses the trailing type clause, and produces a `UnaryExpressionSyntax(BangToken, IsExpressionSyntax(left, isKeyword, typeClause))`. The bound representation of `x !is T` is therefore identical to `!(x is T)`, and every downstream path (binder, lowerer, emitter, printer, walker, rewriter) handles it without further change.
- **Binder — `is` classifier**. `StatementBinder` gains a `TryClassifyTypeTestNarrowing(BoundExpression)` that recognises three shapes:
  - `BoundIsExpression(variable, T)` where the operand is a `BoundVariableExpression` whose `Variable` is a `LocalVariableSymbol` or `ParameterSymbol`. Yields then = `{ variable → T }`, else = `{}`.
  - `BoundUnaryExpression(LogicalNegation, inner)` where `inner` itself classifies into `(then, else)`. Returns `(else, then)` — i.e., the swap that negation implies.
  - `BoundBinaryExpression(LogicalAnd, left, right)` where `left` classifies into `(thenL, elseL)` and `right` classifies into `(thenR, elseR)`. Returns then = merge(thenL, thenR), else = null. (Disjunction is intentionally not classified.)
- **Binder — if-statement integration**. `BindIfStatement` already calls `TryClassifyNilGuard` and `TryClassifyBoolCallNarrowing`. A third call is added — `TryClassifyTypeTestNarrowing` — and the resulting frames are merged with the nil-guard / `[NotNullWhen]` frames before invoking `BindStatementWithNarrowing`. When both classifiers contribute a then-frame, the union is used (the same variable keyed in both is collapsed to the more specific narrowing — type-test wins because it implies non-nil, then the binder rebinds at the union narrowing).
- **Binder — `&&` short-circuit narrowing inside expressions**. `BindBinaryExpression` is extended: when the operator is `LogicalAnd`, the left operand is bound first, classified for narrowing, and the right operand is bound under the resulting then-frame. This makes `x is T && f(x)` narrow `x` inside the call to `f`. (`||` is not extended for the soundness reason discussed above.)
- **Binder — early-exit narrowing propagation**. `BindBlockStatements` already keeps a `memberNotNullFrame` that survives across the block's statements. After binding each top-level statement, if the statement is a `BoundIfStatement` whose then-branch unconditionally exits the enclosing block (return / throw / unconditional goto, including `break` / `continue` which lower to goto, or a block whose last statement does any of those), the else-frame from the if-condition's classifier is merged into the persistent frame so that subsequent reads in this block see the narrowing. The else-frame is computed once at if-binding time and stored on the resulting `BoundIfStatement` via a per-binder side-table keyed by node identity, so the block-walker does not need to re-classify the condition.
- **Emit — narrowed variable read**. `MethodBodyEmitter.EmitExpression(BoundVariableExpression)` is extended: after `EmitLoadVariable(v.Variable)`, if `v.NarrowedType` is non-null and the narrowed CLR type differs from the variable's declared CLR type, the emitter inserts a single conversion opcode — `unbox.any T` when the narrowed type is a value type (the boxed reference must be unboxed back to its native value-type representation) and `castclass T` for any reference-type narrowing. The cast is guaranteed safe because the binder placed it inside a region where an `is` test already verified the runtime type. This is the same single instruction the C# compiler emits at the use site for `if (x is Y y) { … }`; the only difference is that G# does not introduce a new local for `y` — the cast happens inline on each read.
- **Bound tree**. No new bound-node kind is introduced. The narrowing is recorded on the existing `BoundVariableExpression.NarrowedType` slot, which the rewriter (`RewriteVariableExpression`), walker (`VisitVariableExpression`), printer (`WriteVariableExpression`), and spiller (`SpillSequenceSpiller`) already handle. The four bound-node exhaustiveness allowlists therefore require no updates.
- **Closures / lambdas**. The lambda binder pushes a *new* `NarrowedVariables` frame stack when entering a lambda body. The outer frames are saved and restored around the lambda binding so the lambda body binds the captured variable at its declared type. This matches Kotlin's behaviour: a smart cast does not survive into a closure that captures the narrowed variable.

## Examples

```gs
// Positive narrowing — the canonical case.
func Greet(a Animal) {
    if a is Dog {
        a.Bark()
    }
}

// Early-exit narrowing via `!is`.
func Speak(a Animal) {
    if a !is Dog { return }
    a.Bark()
}

// Combined with `&&`.
func GreetNamed(a Animal) {
    if a is Dog && a.Name != "" {
        Console.WriteLine(a.Bark())
    }
}

// `||` does not narrow — both branches see the broader type.
func Maybe(a Animal) {
    if a is Dog || a is Cat {
        // a stays typed as Animal here — `Bark` / `Meow` is rejected.
    }
}

// Reassignment invalidates the narrowing.
func Reset(a Animal) {
    if a is Dog {
        a.Bark()                 // accepted — narrowed.
        a = Animal{}             // narrowing dropped from this point on.
        // a.Bark()              // would be rejected — a is back to Animal.
    }
}

// Value-type narrowing via boxing — emits `unbox.any int32`.
func Sum(boxed object) int32 {
    if boxed is int32 {
        return boxed + 1
    }
    return 0
}
```

## Future work

- **Narrow on user-defined `bool`-returning predicates that imply a type test**. G# already supports `[NotNullWhen]` and `[MemberNotNull]` for nullable narrowing; an analogous attribute for type-test narrowing (mirror of the `[NotNullWhen]` shape but with a target type) could let a user write `func IsDog(a Animal) bool` and have callers benefit from the smart cast. Out of scope for this ADR.
- **Negative-position narrowing inside `&&` short-circuit on `!is`**. Currently `!is` inside a `&&` chain narrows the *else* branch only; we could also propagate the else-narrowing to the rest of the right operand. The Kotlin specification does not include this, so we follow Kotlin.
- **Narrow on instance-property reads that the binder can prove are idempotent** (e.g., a getter on a sealed class that just returns a constant). Out of scope.

## Status

Accepted; implemented in the same PR as this ADR.
