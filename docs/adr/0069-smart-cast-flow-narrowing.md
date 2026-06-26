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

`||` (logical or) was intentionally not narrowed by the original ADR for soundness reasons. The addendum below (issue #712) lifts that restriction by classifying `||` as the De Morgan dual of `&&` (intersection-then, merge-else, right-operand sees left's else-frame), so the *Combinations* rule for `||` is superseded — see the addendum at the bottom of this document for the current semantics.

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
- **Binder — `&&` short-circuit narrowing inside expressions**. `BindBinaryExpression` is extended: when the operator is `LogicalAnd`, the left operand is bound first, classified for narrowing, and the right operand is bound under the resulting then-frame. This makes `x is T && f(x)` narrow `x` inside the call to `f`. (`||` was deferred by the original ADR; the addendum below — issue #712 — extends the same threading to `||` with the De Morgan-dual frame, and superseded by the implementation notes there.)
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

// `||` short-circuit — see the issue #712 addendum below for the
// De Morgan-dual narrowing that this combination now enables.
func Maybe(a Animal) {
    if !(a is Dog) || a.Name == "" {
        return
    }
    a.Bark()    // accepted — a is Dog after the guard.
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

## Addendum — issue #712 (`||` short-circuit and `switch` discriminator)

- **Status**: Accepted (addendum)
- **Date**: 2026-06-21
- **Related**: parent issue [#706](https://github.com/DavidObando/gsharp/issues/706), this addendum's issue [#712](https://github.com/DavidObando/gsharp/issues/712), ADR-0001, ADR-0017, ADR-0067, ADR-0071 (`if let` / `guard let`), ADR-0064 (`if`-as-expression).

This addendum extends the flow-narrowing analysis defined above to two control-flow shapes that the original ADR explicitly deferred. It supersedes the *Combinations* paragraph that read "`||` (logical or) intentionally does **not** narrow inside either branch" — see the new rules below.

### Motivation

The original ADR pinned `&&` narrowing and the early-exit lift, but left `||` short-circuit and `switch` arm narrowing on the table. Real programs hit these shapes constantly: guard-style `if (a == nil || force) { return }`, De Morgan rewrites of `&&`, and `switch x { case T t: ... }` arms that want to call `T`'s methods without re-binding. With ADR-0064 (`if`-as-expression) and ADR-0071 (`if let` / `guard let`) now landed, the soundness analysis required for `||` is the same one those features already perform, so the previous "rejected for now" stance no longer carries weight.

### Rules

#### `||` short-circuit (De Morgan dual of `&&`)

For `cond = left || right`:

1. **Then-frame** = intersection of `left.Then` and `right.Then`. Only narrowings that appear in BOTH operands' then-frames with the same target type survive. Example: `if (x is T || x is T) { ... }` keeps `{ x → T }`. The mixed shape `if (x is T || x is U) { ... }` keeps nothing (consistent with the original ADR's soundness reasoning), because at the use site `x` could be either `T` or `U`.
2. **Else-frame** = merge (union) of `left.Else` and `right.Else`. When the whole `||` is false, both operands were false, so both operands' else-narrowings apply.
3. **Right-operand binding**. The right operand of `||` is bound with `left.Else` pushed as a narrowing frame, so a guard like `a !is Dog || a.Bark() != ""` sees `a` narrowed to `Dog` inside the right operand (because the right operand only runs when the left was false, i.e. `a is Dog`).
4. **Nil-guard composition**. `TryClassifyNilGuard` composes through `!`, `&&`, and `||` recursively before falling through to the leaf `== nil` / `!= nil` shape. This is what makes `if (a == nil || force) { return }; use(a)` narrow `a` to its non-nullable underlying type post-`if`.
5. **Negation interaction**. `!` continues to flip then/else exactly as defined in the original ADR. Composed with the rules above, `if !(a is T) || cond { ... }` lifts the `T` narrowing into the *else* branch (or into the rest of the block on early exit), matching the De Morgan rewrite `if !(a is T && !cond) { ... }`.

#### `switch` arm discriminator narrowing

For `switch x { case <pattern>: <body> default: <body> }`:

1. **In-arm narrowing**. When an arm's pattern is a type-pattern `<ident> is T` (or any pattern that proves the discriminator's runtime type), the discriminator `x` (in addition to the bound arm variable, which was already typed `T`) binds at type `T` inside the arm body. This applies only when `x` is a *stable narrowable receiver* (see below) — mirroring the original ADR's rule for `is`. Mutating `x` inside the arm body drops the narrowing for the remainder of that arm (the same `InvalidateNarrowingsForAssignedVariables` path that the original ADR uses).
2. **Post-switch lift**. After the `switch`, the binder lifts a narrowing into the enclosing block iff
   - the switch is exhaustive (has a `default` or discard arm), AND
   - every arm that does *not* unconditionally exit (`return` / `throw` / `break` / `continue`) contributes the same `{ x → T }` narrowing for the same target type.
   Otherwise nothing is lifted (an unmatched discriminant or a fall-through arm with a divergent narrowing would make the lift unsound). This is the switch analog of the early-exit lift `if a !is T { return }; use(a)` in the original ADR.

#### Stable narrowable receivers

The original ADR restricted narrowing to `LocalVariableSymbol` and `ParameterSymbol`. This addendum extends that allow-list (consistently across both `is`-narrowing and switch-pattern narrowing) to include read-only `GlobalVariableSymbol` (top-level `let` bindings). The rationale is the same as for `let` locals: an immutable binding cannot be reassigned between the test and the use, so the narrowing is sound. Mutable globals (`var` at file scope) are still excluded.

In summary, narrowing applies when the receiver is one of:

- A `LocalVariableSymbol` (`let` or `var` local — `var` is invalidated on assignment), which includes `ParameterSymbol` as a subclass.
- A read-only `GlobalVariableSymbol` (top-level `let`).

Mutable receivers (`var` globals, fields, properties, indexed expressions) remain excluded — they may change between the test and the use.

### Implementation notes (addendum)

- `StatementBinder.TryClassifyTypeTestNarrowing` gains a `LogicalOr` case implementing the intersection-then / merge-else rules above. A new helper `IntersectNarrowingFrames` keeps frames whose entries agree on both variable and target type.
- `ExpressionBinder.ClassifyTypeTestNarrowing` mirrors the same `LogicalOr` rule for expression-position classification (used by the if-expression form added in ADR-0064).
- `ExpressionBinder.TryClassifyTypeTestNarrowingForOr` returns `left.Else` so the binary-expression binder can thread it into the right operand's binding context. `BindBinaryExpression` is extended to push that frame around the right-operand binding when the operator is `||`.
- `StatementBinder.TryClassifyNilGuard` now recursively composes through `!`, `&&`, and `||` at its head, falling through to the existing leaf `== nil` / `!= nil` shape only when no top-level composition matches. This is what makes nullable narrowing benefit from the same De Morgan dual without changes at every call-site.
- `BindSwitchStatement` is rewritten to record, for each arm body, the narrowing frame that the arm contributes for the discriminator. If the switch is exhaustive (has a default/discard arm — see `SwitchHandlesAllValues`), the binder intersects across all non-exiting arms and stores the lifted frame on `BinderContext.PendingSwitchExitFrames`, a side-table keyed by the resulting `BoundPatternSwitchStatement`. `ApplyEarlyExitNarrowings` consults this side-table and merges the lifted frame into the enclosing block's persistent frame, exactly as it already does for `if`/early-exit. `EndsInUnconditionalExit` recognises exhaustive switches where every arm exits, so a downstream `if` after such a switch can also apply its own narrowing.
- No new bound-node kind is introduced — narrowing continues to ride on `BoundVariableExpression.NarrowedType` and the existing emit path (`MethodBodyEmitter.EmitNarrowingCastIfNeeded`) handles the read site. The four bound-tree exhaustiveness allowlists therefore require no updates.
- Interpreter parity: this addendum also fixes a long-standing bug in `Evaluator.EvaluateIsExpression` / `EvaluateAsExpression`, which used `Type.IsInstanceOfType(value)` directly. That check fails for user-declared G# classes (whose runtime representation is `StructValue`, not a CLR-backed instance). Both methods now route through the existing `MatchesType` helper that the pattern matcher already uses; this makes `is` / `as` behave consistently between the emit and interpreter back-ends and is required for the new switch-arm narrowing to function under the interpreter.

### Examples (addendum)

```gs
// `||` else-branch narrowing — De Morgan dual of `&&`.
func GreetOrSilent(a Animal, silent bool) {
    if !(a is Dog) || silent {
        return
    }
    a.Bark()            // accepted — a is Dog after the guard.
}

// `||` right-operand narrowing — right runs only when left was false.
func RunOrCheck(a Animal) bool {
    return !(a is Dog) || a.Bark() != ""   // a binds as Dog inside the right operand.
}

// Nil-guard composition through `||`.
func Length(s string?, force bool) int32 {
    if s == nil || force {
        return -1
    }
    return s.Length     // accepted — s is non-nullable after the guard.
}

// `switch` arm narrowing — both `x` (the discriminator) and `t` (the bound arm
// variable) bind at the arm's narrowed type.
func Describe(a Animal) string {
    switch a {
        case d is Dog: { return a.Bark() }     // a narrowed to Dog inside this arm
        case c is Cat: { return a.Purr() }     // a narrowed to Cat inside this arm
        default: { return a.Describe() }
    }
}

// Post-switch lift — every non-exiting arm contributes the same narrowing.
func RunDogs(a Animal) {
    switch a {
        case c is Cat { return }
        case d is Dog { Console.WriteLine("dog") }
        default       { return }
    }
    Console.WriteLine(a.Bark())    // accepted — a is Dog after the switch.
}
```

## Addendum — issue #1180 (stable member-access paths)

- **Status**: Accepted (addendum)
- **Related**: parent issue [#706](https://github.com/DavidObando/gsharp/issues/706), this addendum's issue [#1180](https://github.com/DavidObando/gsharp/issues/1180), the #712 addendum above, ADR-0001, ADR-0017.

The original ADR (and the #712 addendum) restricted flow-narrowing to *local* roots only: `LocalVariableSymbol`, `ParameterSymbol`, and read-only `GlobalVariableSymbol`. This addendum extends narrowing to **stable member-access paths** — chains of immutable members read through a stable receiver chain (e.g. `b.Pet`, `o.Box.Pet`) — bringing G# to parity with Kotlin's smart-cast rules for properties and other members.

### Motivation

Kotlin smart-casts a property/field access only when the compiler can *guarantee* the value cannot change between the type check and the use. G# previously narrowed only locals, so idiomatic code that tests and then uses an immutable member (`if b.Pet is Dog { b.Pet.Bark() }`) failed to resolve the derived member. This addendum closes that gap while preserving soundness for anything that could be mutated.

### What makes a member path "stable" (Kotlin parity)

Narrowing now keys on an **access path** = a stable root variable followed by zero or more *stable members*. A path narrows only when **every** link is stable:

- **Root** — a local, parameter (`this` included), or read-only global (the existing allow-list).
- **Field link** — a `let`/read-only instance field (`IsReadOnly && !IsStatic`). `var` fields are excluded.
- **Property link** — an *auto-property* (no custom getter) that is immutable (no setter, or `init`-only), not overridable (`!virtual && !override`), not `static`, and has a getter. Properties with a custom getter, `var` (settable) properties, `open`/overridable properties, and static properties are all excluded.
- **Imported / other-compilation members** — members surfaced as CLR member accesses (`BoundClrPropertyAccessExpression`) are never treated as stable, mirroring Kotlin's "same module" requirement (the compiler cannot prove a foreign member has no custom getter / is not overridable).
- **Delegated members** — not stable (G# has no delegated-property form that would qualify).

These predicates live in `SmartCastStability`; the path key is `AccessPath` (a root `VariableSymbol` plus an immutable array of member `Symbol`s with structural equality).

### Invalidation (soundness)

A member-path narrowing is conservatively dropped when anything in scope could change it:

- **Root reassignment** — any path rooted at a reassigned variable is invalidated (as before for locals).
- **Intervening call** — any statement containing a call invalidates *all* member-bearing paths, because a method could mutate reachable state. (Local-only narrowings are unaffected.)
- **Member / indexed / indirect assignment** — invalidates all member-bearing paths.

This is intentionally stricter than Kotlin (which keeps `val`-member casts across benign calls), but it satisfies the issue's explicit "intervening call invalidates" requirement and is trivially sound. Local-root narrowings retain their previous, more precise invalidation behavior.

### Where it applies

Member-path narrowing is produced by the same classifiers as local narrowing — `is` / `!is` tests (statement and expression level, including `&&` / `||` threading and `if`-as-expression), nil-guards, and `switch` arm discriminators — and consumed at every field/property *read* site (`ApplyMemberNarrowing`). Emit inserts the same `castclass` / `unbox.any` after the `ldfld` / `ldsfld` / getter call for a narrowed member read; the lowerer and rewriter carry the narrowed type through (including auto-property reads that lower to backing-field access).

### Examples (addendum)

```gs
open class Animal { var Name string }
class Dog : Animal { func Bark() string { return Name + ":woof" } }

class Box { let Pet Animal }                       // stable: read-only field

func Run(b Box) {
    if b.Pet is Dog {
        b.Pet.Bark()        // accepted — stable path b.Pet narrowed to Dog
    }
}

class Inner { let Pet Animal }
class Outer { let Box Inner }

func Deep(o Outer) {
    if o.Box.Pet is Dog {
        o.Box.Pet.Bark()    // accepted — every link in o.Box.Pet is stable
    }
}

// NOT narrowed — each of these has an unstable link:
class MutBox  { var Pet Animal }                          // var field
class PropBox { prop Pet Animal }                         // settable auto-property
class GetBox  { prop Pet Animal { get { return ... } } }  // custom getter
open class OpenBox { open prop Pet Animal { get; init; } } // overridable

func NoNarrow(m MutBox) {
    if m.Pet is Dog {
        m.Pet.Bark()        // rejected — m.Pet is not stable (var field)
    }
}

// Invalidated by an intervening call:
func CallInvalidates(b Box) {
    if b.Pet is Dog {
        SomethingElse()
        b.Pet.Bark()        // rejected — call may have mutated reachable state
    }
}
```
