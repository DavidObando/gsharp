# ADR-0102: Variadic (`...T`) parameters on methods, interfaces, ctors, lambdas, and delegates

- **Status**: Accepted
- **Date**: 2026-07-25
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #812 (lift the GS0146 restriction from ADR-0101's deferred sites)
- **Related**: Parent #706; ADR-0101 (#799, variadic v1, top-level only); ADR-0074 (#714, arrow lambdas); ADR-0075 (#75, function-type clauses); ADR-0076 (#716, lambda binding inference); ADR-0085 (#85, default interface methods)

## Context

ADR-0101 introduced the `name ...T` variadic parameter spelling, but
restricted acceptance to top-level `func` declarations. Five sites
explicitly listed under the *"Where variadic is allowed in this ADR"*
section continued to reject variadic with `GS0146` ("variadic parameter
not supported here") to keep the v1 surface area small and focused on
the `Sequences.Of` dogfood scenario:

1. Class instance methods.
2. Class static methods (`shared { … }`).
3. Interface methods, including default-interface-method (DIM)
   bodies (ADR-0085).
4. Constructors (`init(…)`).
5. Lambda expressions — both the `func(p ...T) R { body }`
   function-literal form and the `(p ...T) -> body` arrow form
   (ADR-0074).
6. Delegate declarations (`delegate D(…)`).

These deferrals were always understood as scheduling concessions; the
dogfood port (issue #792) only needed top-level functions, and the
call-binding machinery had not yet learned the pack / pass-through
dance from `BindCallExpression` in any other code path. The follow-up
issue #812 carries that lift through.

## Decision

Lift `GS0146` from each of the six sites listed above. The structural
rules from ADR-0101 — *at most one variadic per signature, must be
last, no `params` keyword, element type wrapped in `SliceTypeSymbol`,
emit `ParamArrayAttribute` on the trailing parameter* — apply
unchanged to every additional site. The diagnostic IDs `GS0145`
(must-be-last) and `GS0364` (multiple variadics) continue to fire from
each site; `GS0146` is retained as a still-defined diagnostic for
backwards-compatible diagnostic-ID stability but is no longer reported
from any binder path in the language.

### Site-by-site decisions

#### 1. Class instance methods

```g#
class Joiner {
    func Join(sep string, parts ...string) string {
        var s = ""
        for var i = 0; i < len(parts); i++ {
            if i > 0 { s = s + sep }
            s = s + parts[i]
        }
        return s
    }
}
let j = Joiner{}
j.Join(", ", "a", "b", "c")    // "a, b, c"
j.Join(", ", []string{"x","y"}) // pass-through: "x, y"
j.Join(", ")                    // empty pack: ""
```

- Binder path: `DeclarationBinder.BindClassDeclaration` →
  per-method parameter binding accepts `parameterSyntax.IsVariadic`,
  wraps the type in `SliceTypeSymbol.Get(elementType)`, and constructs
  `ParameterSymbol(..., isVariadic: true, …)`.
- Call binding: `OverloadResolver.BindUserInstanceCall` — extended
  with the same arity (`fixedParamCount + 0..n trailing`) and
  pack / pass-through behavior as the top-level path. Generic inference
  for variadic instance methods consumes the trailing arguments
  against the variadic slot's element type.
- Emit: `ReflectionMetadataEmitter.AddMethodDefinition` already
  emits `[ParamArrayAttribute]` whenever `ParameterSymbol.IsVariadic`
  is set, so no emit change is needed beyond the binder lift.
- Diagnostics retained: `GS0145`, `GS0364`, `GS0147` (too few
  arguments for fixed-portion).

#### 2. Class static methods (inside `shared { }`)

Identical to instance methods, modulo `this`. The declaring scope is
`StaticMethodSymbol` (no implicit receiver); call binding routes
through `OverloadResolver` and reuses the variadic logic from the
instance path. Examples:

```g#
class Sequences {
    shared {
        func Of[T](values ...T) []T { return values }
    }
}
let xs = Sequences.Of(1, 2, 3)     // packs
let ys = Sequences.Of[int32]()     // empty pack
let zs = Sequences.Of([]int32{1})  // pass-through
```

#### 3. Interface methods and default-interface-method bodies

```g#
interface IFormatter {
    func Format(prefix string, parts ...string) string
}

interface IList[T] {
    func AddAll(items ...T) {
        for var i = 0; i < len(items); i++ {
            this.Add(items[i])
        }
    }
    func Add(item T)
}
```

- The variadic flag flows through ADR-0085's DIM emit path; the
  resulting interface MethodDef carries `[ParamArrayAttribute]` on
  the trailing parameter, so C# / F# / VB consumers see the
  interface method *as variadic* in their IDE.
- Virtual / interface dispatch is unchanged. Pack / pass-through is
  resolved at the call site by `BindUserInstanceCall`, before the
  callvirt lowering.

#### 4. Constructors (`init(…)`)

```g#
class Tags {
    let values []string
    init(values ...string) {
        this.values = values
    }
}
let t = Tags("a", "b", "c")
let u = Tags([]string{"x","y"})
let v = Tags()
```

- Binder path: `DeclarationBinder` constructor-parameter binding
  accepts `IsVariadic` and wraps the type in `SliceTypeSymbol`.
- Call binding: `OverloadResolver.BindExplicitConstructorCallExpression`
  reproduces the pack / pass-through logic so the body sees a single
  slice parameter regardless of call shape.
- Emit: ctor MethodDef carries `[ParamArrayAttribute]` on the
  trailing parameter, so a C# consumer writes `new Tags("a", "b",
  "c")` and gets the variadic dispatch the user expects.
- Out-of-scope: primary constructors with a variadic parameter
  are not part of this ADR. The primary ctor's parameter list
  doubles as field declarations, and lifting a `[]T` field
  through a primary ctor's auto-binding raises orthogonal questions
  (initialisation default, mutability of the underlying array).
  The binder currently accepts the syntax on the primary-ctor path
  but call binding for primary ctors continues to follow the
  fixed-arity rule. A follow-up may lift this.

#### 5. Lambdas (function-literal and arrow form)

```g#
let join = (sep string, parts ...string) -> sep + parts[0]
let f = func(xs ...int32) int32 { return len(xs) }
```

- Binder: `LambdaBinder.BindFunctionLiteralExpression` and
  `LambdaBinder.BindLambdaExpression` both accept `IsVariadic` on the
  parameter syntax and wrap the type in `SliceTypeSymbol`. Inside the
  body, the parameter is observed as `[]T`.
- **Caveat at the call site.** The lambda's enclosing
  `FunctionTypeSymbol` has no per-parameter variadic flag — its
  identity is purely *parameter-types → return-type*. As a
  consequence, indirect calls through a function-typed local
  (`let f = func(xs ...int32) int32 { … }; f(1, 2, 3)`) do **not**
  pack: the call must supply a single slice argument
  (`f([]int32{1, 2, 3})`). The variadic-ness is preserved as a
  declaration-site convenience and a documentation marker; lifting
  the call-site packing through `FunctionTypeSymbol` would require
  giving the type a per-parameter `IsVariadic` flag and propagating
  it through every cache/identity site, which is a follow-up.
  When the lambda is assigned to a *named delegate* variable
  (case 6 below) the call-site packing **does** apply.
- Diagnostics retained: `GS0145`, `GS0364`.

#### 6. Delegate declarations and `(…) -> R` function-type clauses

```g#
delegate Joiner(sep string, parts ...string) string
let j Joiner = (sep string, parts ...string) -> parts[0]
j("-", "a", "b", "c")        // packs
j("-", []string{"x","y"})    // pass-through
j("-")                       // empty pack
```

- Binder: `DeclarationBinder.BindDelegateDeclaration` accepts
  `IsVariadic` on the delegate parameter list with the same
  structural rules.
- Emit: `TypeDefEmitter.EmitDelegateTypeDef` now stamps
  `[ParamArrayAttribute]` on the Invoke method's trailing
  parameter (previously absent for delegate Invoke even when
  `IsVariadic` was set, because the emit path bypassed the method
  emit code that handles ParamArray).
- Call binding: the *named-delegate variable* indirect-call branch
  in `OverloadResolver` was extended to perform pack / pass-through
  before dispatching to the lowered Invoke. The behavior matches the
  top-level / instance-method paths exactly.
- Out-of-scope: the structural `(T1, T2, ...T3) -> R` function-type
  clause (ADR-0075) — i.e. the *anonymous* delegate-shaped type
  spelling without a named delegate — is **not** extended in this
  ADR. `FunctionTypeSymbol` carries no per-parameter `IsVariadic`
  flag, so the call-site packing has nowhere to consult. Authors who
  want variadic semantics from a delegate-typed local should declare
  a named `delegate` (case 6 above). The follow-up that lifts this
  is the same `FunctionTypeSymbol` lift mentioned under case 5.

## Diagnostics

| ID | Meaning | Still fires from |
|---|---|---|
| GS0145 | variadic parameter must be last | every site |
| GS0146 | variadic parameter not supported here | **no site** (kept for ID stability; the helper remains in `DiagnosticBag` but is unused) |
| GS0147 | too few fixed arguments for variadic call | every variadic call path |
| GS0363 | `params` keyword not accepted | every site (parser-level) |
| GS0364 | at most one variadic per signature | every site |

## Cross-language interop

A C# consumer calling any of the five lifted G# sites sees
`[ParamArrayAttribute]` on the trailing parameter and may use the
ordinary `params` call syntax. A G# consumer calling a CLR variadic
method (member or delegate Invoke) continues to use the existing
`ParamArrayAttribute` recognition on the CLR-overload-resolution path,
unchanged from prior releases.

## Tests

- Parser tests accept the variadic spelling on each new site.
- Binder tests assert that `ParameterSymbol.IsVariadic` is set and
  that the parameter type is `SliceTypeSymbol`.
- End-to-end emit tests call each variadic site with (a) N positional
  arguments, (b) a single `[]T` arg, and (c) zero trailing args, and
  assert the resulting IL verifies with `ilverify` and that the
  metadata exposes `[ParamArrayAttribute]` on the trailing parameter.
- Interpreter parity tests cover the same shapes.
- A cross-language smoke test calls a G#-authored variadic instance
  method from C# to assert the `params` call shape works.

## Consequences

- The language design intent (variadic is a first-class declaration
  shape) is fully realised — there is no longer a site at which a
  G# author has to accept the wrap-the-arguments boilerplate.
- The two carve-outs (anonymous function-type clause and primary
  constructor) remain as deliberate follow-ups; each has a small
  open-design question that does not block #812 closing.
- Diagnostic ID `GS0146` is preserved but dormant. We do not recycle
  it; future restrictions get a fresh ID.

## References

- ADR-0101 — variadic v1, top-level only (issue #799).
- ADR-0085 — default interface methods (issue #85).
- ADR-0074 — arrow lambdas (issue #714 / #774).
- ADR-0075 — function-type clauses (issue #75).
- ADR-0076 — lambda binding inference (issue #716).
- Parent #706 — G# language current state and design opportunities.
