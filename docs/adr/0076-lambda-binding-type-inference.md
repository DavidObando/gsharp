# ADR-0076: Type inference for lambda bindings

- **Status**: Accepted
- **Date**: 2026-06-26
- **Phase**: Phase 9 — language depth / control-flow polish
- **Related**: parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish), this ADR [#716](https://github.com/DavidObando/gsharp/issues/716), builds on ADR-0074 [#714](https://github.com/DavidObando/gsharp/issues/714) (arrow lambda + `:` switch arms) and ADR-0075 [#715](https://github.com/DavidObando/gsharp/issues/715) (`(T) -> R` function-type clause); does not regress generic method-type inference (ADR-0053)

## Context

ADR-0074 introduced the arrow lambda `(x int32) -> x * x`, and ADR-0075
made the function-type clause spell the same arrow shape: `(int32) -> int32`.
Together they let users **read** and **write** lambdas and their types
in one consistent surface, but binding a lambda to a local still
required spelling the type twice:

```gs
var square (int32) -> int32 = (x int32) -> x * x  // type repeated
let id (string) -> string = (s string) -> s       // type repeated
```

Every other modern language with arrow lambdas (Kotlin, Swift, TypeScript,
F#, Rust, Scala) lets a typed-parameter lambda *be* the source of its
binding's type — the user writes the parameter types once and the
binding picks them up. This ADR closes that gap for G# without giving
up the existing target-typing path (lambda parameters can still omit
types when the binding pins them down) and without regressing the
generic method-type-inference path that powers `xs.Where(...)`.

## Decision

### 1. The inferred binding type is the lambda's `FunctionTypeSymbol`

When a `let` / `var` declaration's initializer is a lambda expression
`(p1 T1, …, pN TN) -> body` whose parameter types are **all** declared
in the lambda parameter list (no untyped slots), the binding's
type **is** the `FunctionTypeSymbol` `(T1, …, TN) -> R` — the exact
same `FunctionTypeSymbol` ADR-0075 introduced as a first-class
type-clause spelling. `R` is computed by §3.

```gs
var square = (n int32) -> n * n        // square : (int32) -> int32
let id     = (s string) -> s           // id     : (string) -> string
let add    = (a int32, b int32) -> a+b // add    : (int32, int32) -> int32
let now    = () -> DateTime.UtcNow     // now    : () -> DateTime
let log    = (m string) -> Console.WriteLine(m)
                                       // log    : (string) -> void
```

The binding's *value* is the same `BoundFunctionLiteralExpression` the
lambda already produced — no new bound-tree shape. Emit and the
interpreter both see exactly the IL / lowering they have today; the
inference is entirely a **binder** affair.

### 2. The inference algorithm — bottom-up, then top-down, two-pass when both sides are partial

The variable-declaration binder distinguishes three cases:

1. **Binding has an explicit function-type AND initializer is a lambda.**
   Top-down (existing path, extended). The binding's declared
   `FunctionTypeSymbol` is fed to the lambda binder as the *target*.
   Any lambda parameter without an explicit type is filled from the
   target's parameter-list at the matching index; if arities or
   element types disagree the existing conversion diagnostics fire on
   the assignment. The lambda's body is bound in this target context;
   if every `return` (and the trailing expression) is convertible to
   the target's declared return type, the target return type wins.

   ```gs
   let f (int32) -> int32 = (x) -> x + 1   // x is int32 from target
   ```

2. **Binding has *no* explicit type AND initializer is a lambda whose
   parameters are all typed.** Bottom-up (new path). The lambda's
   parameter types come from the lambda syntax. The body is bound in
   that scope. The return type is the common type of every value-
   producing path through the body (§3). The binding's type is the
   `FunctionTypeSymbol` `(T1, …, TN) -> R`.

   ```gs
   var square = (n int32) -> n * n         // square : (int32) -> int32
   ```

3. **Both sides are partial** (no explicit binding type, AND at least
   one lambda parameter is untyped). The binder reports the new
   diagnostic `GS0304` on the first untyped parameter and the lambda
   binds in error mode. The binding then takes its type from the
   error-typed lambda; downstream uses of the binding cascade into the
   existing error-suppression machinery (no extra diagnostics fire).

```text
   let f = (x) -> x + 1
           ─^─
   GS0304 Cannot infer the type of lambda parameter 'x'. …
```

The algorithm is a single dispatch in the variable-declaration binder
followed by a single bottom-up pass inside the lambda binder; there is
no fixed-point iteration. The bottom-up pass is conceptually identical
to the algorithm that already powers `var x = expr` for non-lambda
initializers — the lambda is treated as a special expression whose
*value-bearing* type happens to be derivable from its declared
parameters.

### 3. The return-type rule — common type of every value path

Inside the lambda binder, when no target return type is available
(case (2) above), the inferred return type `R` is the **common type**
of:

1. The trailing expression's type (for an arrow body
   `(p) -> expr` this is `expr`'s type; for an arrow body whose body
   is a `BlockExpression`, this is the trailing expression of the
   block — `void` if the block has no trailing expression).
2. The expression type of every `return e` statement reachable in the
   body (`return;` contributes `void`).

The common-type rule is the same one ADR-0062 prescribes for
conditional expressions and matches `ExpressionBinder.ComputeCommonType`:

- Identity wins (`R == R`).
- One-way implicit conversion wins (`A → B` implicit but not the
  reverse → result is `B`).
- Both-way implicit conversion picks the *left* arm deterministically
  (the first candidate encountered in source order is the prefix of
  the candidate set).
- Otherwise no common type exists and `R = error`; the lambda's
  binding becomes error-typed and the offending return / trailing
  expression carries the diagnostic from the underlying conversion
  attempt.

When the body has explicit `return` statements **and** no value-bearing
trailing expression (the body is `{ stmts; }` rather than
`{ stmts; trailing }`), the synthetic `void` placeholder injected by
the block-expression binder is **excluded** from the candidate set —
without this carve-out, a block such as `{ return 1 }` would yield a
common type of `(int32, void)` and bind to `error`. With the carve-
out, the same block yields `R = int32` as expected.

After `R` is computed, the lambda binder rewrites the bound body so
each `return e` statement's expression is converted to `R` (via
`Conversion.BindConversion`). The post-bind rewrite uses the existing
`BoundTreeRewriter` and walks only the lambda's own body — nested
function literals are opaque (`BoundTreeRewriter` already short-
circuits at `BoundFunctionLiteralExpression`), so a nested lambda's
own `return`s do not leak into the outer lambda's candidate set.

### 4. Async lambdas

`async (n int32) -> n * 2` infers the same way as a non-async lambda,
with one observable difference: the binding type's return slot is
wrapped via the existing `LambdaBinder.WrapAsTask` helper, so

```gs
let doubleAsync = async (n int32) -> n * 2
//   doubleAsync : async (int32) -> int32
//   value type : (int32) -> Task<int32>
```

When the binding has an explicit target function type and the lambda
is `async`, the binder *unwraps* the target return slot (`Task` →
`void`, `Task<T>` → `T`) before comparing it against the body's
candidates — `LambdaBinder.UnwrapTaskReturnType` matches the symmetry
async function declarations already enjoy. The target-type-wins rule
of §2 (case 1) then applies to the unwrapped element type.

### 5. Recursive `let` / `var` bindings are **not** supported

```gs
let f = (n int32) -> if n == 0 { 0 } else { f(n-1) }   // f not in scope
```

A `let` / `var` binding's name is not visible inside its own
initializer (existing G# scoping rule shared with C# `var`, Kotlin
`val`, Swift `let`, Rust `let`). The lambda body therefore sees no
binding named `f` and reports the existing `GS0125` "Variable 'f'
doesn't exist" diagnostic. This ADR does **not** widen scoping rules
to make the binding visible inside its own initializer — the workaround
is to declare a function:

```gs
func f(n int32) int32 {
    if n == 0 { return 0 } else { return f(n - 1) }
}
```

Function declarations enter their own scope before binding their body,
which is the existing mechanism for self-recursive functions. Lifting
this restriction for `let` / `var` bindings would require a separate
ADR with a scoping model for forward references and is intentionally
out of scope.

### 6. Generic method-type inference is unchanged

Lambdas passed as method arguments still flow through the existing
method-type-inference path (ADR-0053). The new bottom-up inference
applies only when the lambda is the *initializer of a variable
declaration*; method arguments hit the existing argument-conversion
pipeline. Concretely:

```gs
list.Where((x int32) -> x > 0)              // existing path; unchanged
list.Where(func(x int32) bool { x > 0 })    // existing path; unchanged
```

The new diagnostic `GS0304` fires only from
`LambdaBinder.BindLambdaExpression` when a lambda parameter has no
explicit type AND no target type was supplied. For method arguments
without target context (a non-generic delegate parameter expects
typed lambda params; a generic parameter cannot pin the slot without
itself being inferred), the diagnostic is fired by the lambda binder
and is followed by the existing overload-resolution diagnostic, which
is acceptable — the user is told both *what* to do (type the param
or annotate the binding) and *why* (the overload could not match).

### 7. Diagnostic GS0304

```
GS0304: Cannot infer the type of lambda parameter '<name>'. The parameter
has no explicit type and no target type is available; either add a type
(e.g. '(x int32) -> ...') or declare the binding with an explicit
function type (e.g. 'let f (int32) -> R = ...').
```

Allocated at the next free ID after ADR-0075's `GS0303`.

### 8. Bound tree, emit, interpreter

- **No new `BoundNodeKind`.** The lambda still binds to
  `BoundFunctionLiteralExpression`. The synthetic `FunctionSymbol`
  exposed by that node gains a new boolean flag,
  `FunctionSymbol.IsReturnTypeInferred`, used **only during binding**
  to defer the implicit-return-type-conversion check in
  `StatementBinder.BindReturnStatement` until the lambda binder has
  finished computing `R` and re-walked the body. The flag is not
  observed by emit, the interpreter, the rewriter, the walker, the
  printer, or the spill spiller.
- **No new diagnostics other than GS0304.** Every other failure mode
  (param-type mismatch, return-type mismatch, capture-of-by-ref, etc.)
  uses the existing diagnostic IDs.

## Consequences

Positive:

- The common case of "bind a lambda to a local" stops requiring a
  spelled-out function type. The user writes parameter types once and
  the binding picks them up — exactly the Kotlin / Swift / TypeScript /
  F# / Rust / Scala ergonomic.
- The target-typing path (case 1 in §2) is preserved: callers who
  *do* want to spell the type and let the lambda body inherit it
  still can.
- Generic method-type inference is unchanged. `xs.Where((x int32) -> x > 0)`
  continues to bind with the existing pipeline.
- No new bound-tree shape. Emit, interpreter, lowering, the rewriter,
  the walker, the printer, and the spill spiller need no changes; the
  exhaustiveness allowlists need no updates.

Negative:

- The variable-declaration binder now has three distinct lambda-
  initialization paths (no type → bottom-up; explicit type → target-
  typed; both partial → diagnostic). The complexity lives in the
  binder, not in the rest of the compiler.
- A user who writes `let f = (x) -> body` expecting `x` to be inferred
  from later uses of `f` (Hindley-Milner-style) gets `GS0304` instead.
  The diagnostic message points at the two well-supported alternatives.

Neutral:

- Recursive `let` self-reference remains an error (§5). This is the
  same restriction every other `var`-style local has and is
  consistent across the existing language.

## Alternatives considered

### A. Always require an explicit function-type binding clause

Considered and rejected. The repeated `(T) -> R` on both sides of a
lambda binding is the exact symptom this ADR exists to fix; making
the user spell it twice forever defeats the entire point of
ADR-0074 + ADR-0075.

### B. Two-pass / fixed-point inference (Hindley-Milner-style)

Considered and rejected. Adding full unification-based parameter-
type inference would require a fundamental redesign of the binder
and would interact with overload resolution, generic methods,
operator binding, and target-typing in ways well beyond this ADR's
scope. The dispatch in §2 is a single binder pass and gets the
ergonomic 95% of the way there for the cost of a `bool` flag and one
helper.

### C. Make `let f = (n int32) -> if n == 0 { 0 } else { f(n-1) }` self-recursive

Considered and rejected. Allowing a `let` binding's name to be in
scope inside its own initializer is a scoping decision that affects
every value-bearing initializer in the language, not just lambdas. A
separate ADR is the right venue if the team decides forward-references
in `let` initializers are worthwhile. The `func` declaration form is
the documented workaround.

### D. Infer the lambda's parameter types from later uses

Considered and rejected. This would require a whole-method
unification pass with potential backtracking on overload resolution
and would introduce diagnostics whose locations are far from the
lambda being analysed. The current rule — *parameter types come from
the lambda syntax or from an explicit target* — is local, predictable,
and matches Kotlin / Swift / Scala.
