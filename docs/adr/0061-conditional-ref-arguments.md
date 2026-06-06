# ADR-0061: Conditional ref-arguments — `cond ? lvalue : lvalue` at ref-argument positions

- **Status**: Accepted
- **Date**: 2026-06-05
- **Implemented**: 2026-06-05 (PR [#495](https://github.com/DavidObando/gsharp/pull/495))
- **Phase**: Phase 8 — language ergonomics / CLR-interop surface
- **Related**: issue #492 (conditional ref-passing follow-up to ADR-0060); ADR-0060 (`ref`/`out`/`in` parameters), ADR-0058 (ref-safe-to-escape), ADR-0039 (managed by-ref pointers `&`/`*` / `ByRefTypeSymbol`), ADR-0062 (generalized ternary expression)

## Context

ADR-0060 §Foreclosed explicitly defers **conditional ref-passing** (`f(cond ? ref x : ref y)`):

> The ternary form requires both branches to produce the same lvalue *category*, which is a meaningful escape-analysis question; deferred until there is concrete demand.

The follow-ups section adds:

> `f(cond ? ref x : ref y)` and similar lvalue-ternary forms; a focused mini-ADR after ref-safe-to-escape's data-flow tracker is mature.

Today, callers must spill into a managed-pointer temporary:

```gsharp
let target = useA ? &counterA : &counterB   // illegal — no ternary exists yet
Interlocked.Increment(ref *target)
```

Worse — G# has *no general ternary* expression at all. `BoundIfStatement` exists but `if` is not value-producing, and the only conditional expression form is `switch { ... }` (which is too heavy for a two-arm conditional and does not surface lvalue branches). The workaround in practice is to duplicate the call:

```gsharp
if useA {
    Interlocked.Increment(ref counterA)
} else {
    Interlocked.Increment(ref counterB)
}
```

which is verbose, obscures the intent (the conditional is over *which lvalue*, not over *which call*), and forces every additional argument to be repeated.

The motivating call shapes are precisely the ones ADR-0060 enabled — `Interlocked.Increment(ref c)`, `TryParse(out r)`, `Consume(in big)`, raw `&p` — applied to a *runtime-selected* target slot. The CLR has no special instruction for "ref to one of two slots"; the legal lowering is a CIL branch that pushes one of two managed-pointer values onto the evaluation stack before the call. Compilers routinely do this (C# `f(cond ? ref x : ref y)` is exactly the same pattern). What is missing in G# is the *surface*.

The constraint envelope:

- **No general ternary.** Introducing `cond ? a : b` as a general expression form would be a much larger language decision (precedence, interaction with nullable `?`, lvalue-ness of every two-arm conditional, etc.) and properly belongs in its own ADR. We want the ergonomic win at ref-argument positions *without* committing G# to a general ternary.
- **Lvalue category must match.** Both branches must produce true lvalues of the same type (no implicit conversion across branches). The result must itself be addressable as `T&`.
- **Ref-safe-to-escape (ADR-0058) compatibility.** Each branch produces a managed pointer with its own ref-safe-to-escape scope. The combined expression's scope is the *narrower* of the two; the receiving parameter's required scope must be ≥ that combined scope.
- **All four ref-kinds.** `ref`, `out`, `in`, and the bare `&` operand must all accept the new form. (`out` with the conditional has the additional definite-assignment subtlety addressed in §4 below.)

## Decision

Introduce a **call-site-only conditional ref-argument** form, syntactically restricted to the payload of a ref-kind modifier (`ref` / `out` / `in`) and to the operand of the address-of operator (`&`). The form is `cond ? lvalue₁ : lvalue₂` and produces a `BoundConditionalAddressExpression` of type `T&` where `T` is the common pointee type of the two branches. The bound node is structurally a "conditional address-of" and is accepted everywhere a `BoundAddressOfExpression` of type `T&` is accepted today (call-site argument loops, ctor argument loops, emit dispatch).

The `?` and `:` tokens at this position are *not* a general ternary expression — they are a position-specific conditional-lvalue production. A user-defined ternary expression is out of scope for this ADR and may be revisited later.

### 1. Surface

The grammar of `TryParseRefArgument` and `BindAddressOfExpression` is extended:

```
RefArgument     := ('ref' | 'out' | 'in') ConditionalLvalue
AddressOfExpr   := '&' ConditionalLvalue
ConditionalLvalue := Expression ['?' [RefKindModifier?] Lvalue ':' [RefKindModifier?] Lvalue]
```

The inner `RefKindModifier?` on each branch is optional and, if present, must match the outer modifier (`ref … ? ref x : ref y`). The grammar accepts both styles for parity with C# (`f(cond ? ref x : ref y)`):

```gsharp
// Issue #492 — `Interlocked.Increment` against a runtime-selected counter:
var counterA = 0
var counterB = 0
var useA = true
Interlocked.Increment(ref useA ? counterA : counterB)
Interlocked.Increment(ref useA ? ref counterA : ref counterB)   // identical

// `out` form:
TryGet(out useA ? slotA : slotB)

// `in` form:
Consume(in useA ? bigA : bigB)

// Bare address-of:
let p = &(useA ? counterA : counterB)        // p : *int32
*p = *p + 1
```

The inline-declaration `out` shapes (`out var n`, `out let n`, `out _`) are **not** combinable with the conditional form in v1: declaring a fresh local on only one branch of a conditional is semantically incoherent. A diagnostic is emitted (GS0246) and the workaround is to declare the local explicitly before the call.

Named-argument tails (ADR-0060 §4, issue #343) compose: `f(target: ref useA ? a : b)` parses and binds identically to the positional form.

### 2. Binding

`BindConditionalRefArgument` performs the following checks in order, emitting a diagnostic at the first failure:

1. **Condition is `bool`.** Standard expression type check. Otherwise GS0029 (existing diagnostic for non-bool conditions in if/while/for).
2. **Both branches are lvalues.** Each branch must satisfy `IsLvalue` (the same predicate used by `&x`, `BindRefArgumentExpression`, and `BindAddressOfExpression`). Otherwise GS0244 (existing "cannot take address of non-lvalue") is reported, with the branch's location.
3. **Both branches have the same type.** No implicit numeric widening, no nullable adjustment, no reference-conversion across the branches — the pointee must match exactly. Otherwise GS0247 (new) is reported, naming both types. Rationale: a `T&` selected at runtime cannot point at a slot of a *different* type without an unobservable bit-cast.
4. **Readonly compatibility.** For `ref` (and bare `&`) both branches must be writable (no `let`-local on either side). For `in` both branches may be read-only. For `out`, both branches must be writable — and per §4 below, definite-assignment is enforced *for both branches* on the post-call program point.
5. **Ref-safe-to-escape compatibility.** Each branch's ref-safe-to-escape scope is computed via the existing ADR-0058 tracker (`ComputeRefSafeToEscape`). The combined scope is `min(scopeTrue, scopeFalse)`. If the receiving parameter's required scope is wider than the combined scope, GS0248 (new) is reported, naming the narrower branch.

On success, the bound node is `BoundConditionalAddressExpression(condition, whenTrueOperand, whenFalseOperand, pointeeType)` with `Type = ByRefTypeSymbol.Get(pointeeType)`. It is *not* a `BoundAddressOfExpression`; sites that previously pattern-matched on `BoundAddressOfExpression` to recognise a ref-argument address are extended to accept both via a small interface (`IBoundAddressExpression` — pointee type + emit hook).

### 3. Emit

The lowered IL for `f(ref cond ? a : b)` is a CIL branch that selects one of two address-of forms onto the evaluation stack before the call:

```
<emit cond>         // i4 on stack
brfalse L_false     // 0 → false branch
<emit address of a> // T& on stack
br      L_done
L_false:
<emit address of b> // T& on stack
L_done:
<emit other args>
call    f
```

This is implemented in `EmitImportedCallArguments` (and its ctor sibling) by dispatching on the bound-tree node: `BoundAddressOfExpression` continues to call `EmitAddressOf`; `BoundConditionalAddressExpression` calls a new `EmitConditionalAddress` that defines two `LabelHandle`s on the existing `il` builder and re-uses `EmitAddressOf` for each branch's lvalue.

No spill into a managed-pointer local is required: the two `EmitAddressOf` paths leave a `T&` on the stack with the same verifier type, and the CLR's stack-merge rule for byrefs accepts the branch join. (This matches Roslyn's emit for the equivalent C# pattern.)

For the bare `&(cond ? x : y)` form the same emit applies; the result type is `*T` (= `T&`) and flows into `BoundAddressOfExpression` consumers (e.g. a `*T`-typed local initializer) unchanged.

### 4. Definite-assignment for `out`

A `BoundConditionalAddressExpression` under an `out` parameter must, after the call returns, leave **both** branch lvalues definitely assigned — because we cannot statically prove which branch was taken. The existing `RefKindDefiniteAssignmentAnalyzer` is extended to walk the conditional node and mark *both* branches as assigned by the call (using the same mechanism it uses today for a plain `out` argument). This is conservative-correct: at run time only one branch is actually assigned, but the analyzer's "after the call, this variable is assigned" guarantee is sound because the call's behaviour is identical to two parallel `if` arms each containing a single `out` call.

### 5. Composition with named arguments

A conditional ref-argument may appear as the value of a named argument: `f(target: ref cond ? a : b)`. The named-argument parser already calls into `TryParseRefArgument`; no separate change is required. The bind-time diagnostic family is the same.

### 6. Foreclosed (v1)

- **Three-way or n-way conditionals.** Only the two-arm `?:` form is recognised. A switch-expression-shaped lvalue selector (`switch x { 1 -> ref a; default -> ref b }`) is a separate, larger feature.
- **Inline-declaration `out` branches** (`ref cond ? out var n : out var m`). One branch declaring a local that only conditionally exists is incoherent. Emit GS0246.
- **General ternary expression.** This ADR does *not* introduce `cond ? a : b` as a value expression in arbitrary positions. That remains a separate decision.
- **Mixed-modifier branches** (`ref cond ? ref x : in y`). The inner modifiers on each branch, if present, must match the outer modifier. Otherwise GS0249 (new).

## Consequences

- **Ergonomics.** Eliminates a verbose two-statement spill for the most common conditional ref-pass cases against `Interlocked.*`, `Volatile.*`, and `Try*`/`Get*` family methods. The intent (conditional *target slot*) is now visible at the call site.
- **No new runtime cost.** Lowering is a CIL branch around two address-of forms; identical to the IL a programmer would write today by hand-duplicating the call.
- **Bound-tree surface.** One new bound node (`BoundConditionalAddressExpression`), one new internal interface (`IBoundAddressExpression`) that `BoundAddressOfExpression` and the new node both implement, walker/rewriter additions, and a side-effect-analyzer case (always considered side-effecting because the condition is observable).
- **Diagnostics added.** GS0246 (inline-decl in conditional branch), GS0247 (branch type mismatch), GS0248 (escape-scope mismatch), GS0249 (mixed inner modifiers).
- **Forward-compatibility.** When a general ternary expression is introduced later, the parser path for conditional ref-arguments can be subsumed by it (binder recognises any value-producing expression whose branches are lvalues and lifts it into the same bound node). The intermediate position-specific syntax remains valid.

## Follow-ups

- **General ternary expression.** Covered by ADR-0062. The binder/parser path here can be folded into the general conditional-expression pipeline once ADR-0062 is implemented.
- **Composition with `let ref x = expr`.** Pairs naturally with the aliasing-locals follow-up.

## References

- Issue #492 (this proposal)
- ADR-0060 §Consequences (Foreclosed), §Follow-ups
- ADR-0058 (ref-safe-to-escape)
- ADR-0039 (managed by-ref pointers)
- PR #489 (ADR-0060 implementation)
