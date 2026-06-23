# ADR-0119: Inferred-type arrow lambdas are the canonical lambda form

- **Status**: Accepted
- **Date**: 2026-06-22
- **Phase**: v0.2 — language surface
- **Related**: ADR-0074 ([#714](https://github.com/DavidObando/gsharp/issues/714)) (arrow lambda `->` + `:` switch arms; retrofitted with the bare single-parameter form from [#932](https://github.com/DavidObando/gsharp/issues/932)), ADR-0075 ([#715](https://github.com/DavidObando/gsharp/issues/715)) (`(T) -> R` function-type clause), ADR-0076 ([#716](https://github.com/DavidObando/gsharp/issues/716)) (type inference for lambda bindings), ADR-0050 (`RightArrowToken`), ADR-0108 (delegate target-typing for CLR Func/Action/Predicate)
- **Issue**: [#951](https://github.com/DavidObando/gsharp/issues/951)

## Context

G# has, across several increments, grown a rich arrow-lambda surface:

- ADR-0074 introduced the arrow lambda `(x int32) -> x * x` and the bare
  single-parameter form `x -> x * x` (the paren-drop simplification landed
  through [#932](https://github.com/DavidObando/gsharp/issues/932)).
- ADR-0075 made the function-type clause spell the same arrow shape:
  `(int32) -> int32`.
- ADR-0076 let a lambda **omit its parameter and return types** when the
  binding's declared type supplies them (`let f (int32) -> int32 = (x) -> x * x`).
- ADR-0108 and related work (issues #891 / #908) added **target-typed**
  inference when an untyped arrow lambda flows into a CLR `Func` / `Action` /
  `Predicate` parameter of an imported method (so LINQ `Where` / `Select`,
  `List.Exists`, `Array.ForEach` already accepted `(x) -> …`).

The result is that an untyped arrow lambda — `(x) -> x + 1`, `x -> x + 1`,
`(a, b) -> a + b` — *reads* as the natural, idiomatic way to write a lambda
in G#, while the explicit form `func (x int32) int32 { return x + 1 }`
remains available for when the author wants the types spelled out.

What was missing was twofold:

1. **A canonical statement.** No ADR declared the inferred-type arrow lambda
   to be *the* canonical lambda form, leaving the relationship between the
   arrow lambda and the explicit `func` literal under-specified for authors
   and tooling.
2. **Inference completeness in mainstream contexts.** Target-typed inference
   only fired for **CLR (imported)** call targets. An untyped arrow lambda
   passed to a **user-declared** function, method, interface method, or static
   method — or assigned to a typed local of a CLR delegate type — failed with
   `GS0304` ("cannot infer the type of lambda parameter") even though the
   target shape was statically known. These are exactly the contexts a user
   exercises first when writing their own higher-order APIs, so the canonical
   form did not actually work end-to-end.

A representative pre-existing gap:

```gsharp
func Apply(f Func[int32, int32], v int32) int32 { return f(v) }

shared {
    func Main() {
        // GS0304: Cannot infer the type of lambda parameter 'x'
        let r = Apply((x) -> x + 1, 41)
    }
}
```

## Decision

### 1. The inferred-type arrow lambda is canonical

The **canonical** way to write a lambda in G# is the arrow lambda with
**inferred parameter and return types**, target-typed from the expected
delegate type at the use site. The explicit `func (x T) R { … }` literal
remains a fully supported **alternative** for when explicit typing is desired
or required (e.g. to document intent, to disambiguate, or where no target
type is available).

### 2. Supported canonical forms

| Form | Example | Notes |
|------|---------|-------|
| Multi-parameter, parens | `(a, b) -> a + b` | Parameter types inferred from the target |
| Single-parameter, parens | `(x) -> x * x` | |
| Single-parameter, bare (paren-drop) | `x -> x * x` | From [#932](https://github.com/DavidObando/gsharp/issues/932); credited in ADR-0074 |
| Block body | `(x) -> { let y = x * 2; return y + 1 }` | Return type inferred from the `return` expression |
| Explicit (alternative) | `func (x int32) int32 { return x + 1 }` | Types spelled out; no inference required |

### 3. How inference works

When an untyped arrow lambda appears in a position with a known
**delegate-convertible** target type, the binder extracts a
`FunctionTypeSymbol` shape from that target via
`MemberLookup.TryGetDelegateFunctionTypeFromSymbol` (which understands the
G# `(T) -> R` function type, named delegate types, and CLR
`Func` / `Action` / `Predicate`), target-types the lambda against that shape
so the omitted parameter types and inferred return type are filled in, and
then converts the bound lambda to the exact target type so the correct
delegate adapter is materialised.

To make this work for **user-declared** call targets, untyped arrow-lambda
arguments are now **deferred** during the eager argument pass (bound to a
placeholder carrying the lambda syntax, with *no* premature `GS0304`), and
re-bound once overload resolution has selected the callee and the parameter
type is known. The same deferral/re-bind pattern now covers:

- free functions,
- user instance methods and interface methods,
- user static methods (`Type.Method(lambda)`), and
- typed locals of a CLR delegate type (`let f Func[int32, int32] = (x) -> …`).

If, after re-binding, the target is **not** delegate-convertible, the lambda
is bound with no target so the established `GS0304` diagnostic still surfaces.

### 4. Return-type inference

The return type of the delegate flows from the lambda body: an expression-bodied
lambda's result type, or a block-bodied lambda's `return` expression type, is
unified against the target's return slot. A `void`-returning target
(`Action`, or a function type with no result) accepts an expression-bodied
lambda whose body is a statement-expression (ADR — issue #889).

## Consequences

### Scope implemented

The following canonical inferred-type scenarios are verified to compile **and
run** with correct results (regression tests in
`test/Compiler.Tests/Emit/Issue951CanonicalArrowLambdaEmitTests.cs`):

| Scenario | Status |
|----------|--------|
| Free function, `Func[T,R]` param, `(x) -> …` | ✅ fixed |
| Free function, `Func[T,R]` param, bare `x -> …` | ✅ fixed |
| Free function, G# `(T) -> R` function-type param | ✅ fixed |
| Free function, `Action[T]` param | ✅ fixed |
| Free function, `Predicate[T]` param | ✅ fixed |
| Free function, multi-parameter `(a, b) -> …` | ✅ fixed |
| Free function, block-body `(x) -> { … return … }` | ✅ fixed |
| Return-type inference flows from body expression | ✅ fixed |
| Typed local of CLR delegate (`let f Func[int32,int32] = …`) | ✅ fixed |
| User **instance** method, `Func` param | ✅ fixed |
| **Interface** method, `Func` param | ✅ fixed |
| User **static** method (`Type.M(lambda)`), `Func` param | ✅ fixed |
| LINQ-style `Where` / `Select` over `List[T]` | ✅ pre-existing |
| `List.Exists` (`Predicate`) | ✅ pre-existing |
| `Array.ForEach` (CLR static, `Action`) | ✅ pre-existing |
| Typed local of G# function type (`let f (int32)->int32 = …`) | ✅ pre-existing (ADR-0076) |

Authors can now write higher-order APIs of their own and call them with the
canonical arrow lambda exactly as they would call LINQ.

### Trade-offs

- The deferral mechanism adds a re-bind pass for untyped arrow-lambda
  arguments. It only triggers when an argument is an untyped arrow lambda, so
  the common path is unaffected.
- Because a deferred lambda contributes no type information until *after* the
  callee is chosen, it cannot participate in overload selection (see Deferred).

## Deferred (out of scope)

These contexts still require an explicit type (the explicit `func` form, or
spelling the lambda's parameter type) and are intentionally deferred. Each is
a narrow, non-mainstream case relative to call-site argument inference:

1. **Class/struct field initializers** — `var F Func[int32,int32] = (x) -> x + 1`
   inside a type body. This flows through the declaration binder rather than
   the statement/overload binders patched here. *Workaround:* type the
   parameter (`(x int32) -> x + 1`) or use the explicit `func` form.
2. **Assignment to an existing delegate-typed lvalue** — `obj.F = (x) -> x + 1`.
   The conversion happens across many scattered `BindConversion` sites in the
   assignment binder; threading deferral through all of them is a larger change.
   *Workaround:* same as above.
3. **Overloaded free-function disambiguation by lambda shape** — when two
   overloads differ only in their delegate parameter's shape, a deferred
   (untyped) lambda contributes nothing to overload resolution and the call is
   reported ambiguous (`GS0266`). *Workaround:* type the lambda parameter so
   its shape participates in selection.

Each deferred case has a clear, local workaround and none blocks the canonical
form in the contexts users reach for first. They are candidates for follow-up
work.

## Alternatives considered

- **Eagerly bind every arrow lambda, inventing parameter types.** Rejected:
  without the target shape there is no sound type to invent, and it would
  produce confusing downstream diagnostics. Deferral preserves the existing
  `GS0304` behaviour precisely where no target exists.
- **Make the explicit `func` form canonical and treat arrow lambdas as
  sugar.** Rejected: the arrow lambda is the form users overwhelmingly reach
  for, reads most cleanly, and matches the direction set by ADR-0074/0075/0076.
  Canonicalising the inferred-type arrow lambda matches real usage.
- **Solve overload disambiguation by speculative re-binding against each
  candidate.** Deferred: this is the principled long-term fix for case (3)
  above but is materially more complex (speculative binding with rollback) and
  not required for the canonical single-candidate scenarios.
