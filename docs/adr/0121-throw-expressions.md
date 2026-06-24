# ADR-0121: Throw expressions (`throw` in value position)

- **Status**: Accepted
- **Date**: 2026-06-23
- **Phase**: Phase 9 — language depth / null-handling ergonomics
- **Related**: ADR-0062 (general ternary conditional), ADR-0116 (`??` null-coalescing operator), ADR-0072 (`??=`), ADR-0115 (cs2gs migration tool), issue [#1018](https://github.com/DavidObando/gsharp/issues/1018)

## Context

`throw` in G# was **statement-only** (`ThrowStmt = "throw" Expression`). The
common C# idioms that place `throw` in *expression* position did not parse:

```gsharp
func f(s string?) string {
    return s ?? throw Exception("null")   // GS0005: Unexpected token <ThrowKeyword>
}
```

This forces awkward rewrites — an explicit `if (s == nil) { throw … }` guard, or
an unreachable tail expression after a `throw` statement inside an if/switch
block. It was surfaced concretely while migrating `Oahu.Decrypt` via the cs2gs
tool (issue #914): the translator had to lower C# throw-expressions to an
`if`-block workaround instead of emitting the faithful form.

C# models a *throw-expression* as having the **bottom** ("never") type, which is
implicitly convertible to any target type and never produces a value, so
`s ?? throw e` takes the type of `s` and `cond ? a : throw e` takes the type of
`a`.

## Decision

1. **`throw e` is usable as an expression** (a *throw-expression*) in the common
   positions C# allows: the right-hand side of `??`, a branch of the conditional
   operator, a returned operand, a lambda/arrow body, and an argument. A bare
   `throw e` at statement start remains the throw **statement** — the statement
   parser intercepts `ThrowKeyword` before expression parsing, so existing code
   is unaffected and there is no ambiguity.

2. **Parser.** A new `ThrowExpressionSyntax` (`SyntaxKind.ThrowExpression`) is
   produced by a `throw` case in `ParsePrimaryExpression`. The operand is parsed
   at full-expression precedence (greedy), matching C#'s rule that
   `a ?? throw b ?? c` throws `(b ?? c)`.

3. **Binder.** `BoundThrowExpression` (`BoundNodeKind.ThrowExpression`) has the
   new bottom type `TypeSymbol.Never`. The operand is validated to be a
   `System.Exception` (or derived), reusing the throw-statement's existing rule
   (otherwise `GS0155`). `Conversion.Classify(Never, T)` is **implicit** for any
   `T`; `BindConversion` returns the throw-expression unwrapped (no conversion
   node is synthesized). The `??` operator binder resolves `x ?? throw e` to the
   left operand's underlying type, and `ComputeConditionalCommonType` /
   `ConvertConditionalBranch` resolve a `Never` branch to the sibling's type.

4. **Emit.** A throw-expression lowers to the operand followed by CIL `throw`,
   which never returns — no value is left on the evaluation stack and the code
   after it is unreachable. For `??` and the ternary, the throw branch never
   reaches the merge point, so the existing `dup; brtrue` (`??`) and
   `brfalse / br` (conditional) shapes remain stack-balanced and verifiable
   (ilverify-clean). Max-stack is computed automatically by the
   `ControlFlowBuilder`.

5. **Interpreter.** The evaluator raises the exception for a
   `BoundThrowExpression` exactly as for the throw statement (CLR-backed
   instance when present, else the bound value).

## Consequences

### Positive

- Faithful C# idioms parse and run: `s ?? throw e`, `cond ? a : throw e`,
  `return throw e`, `(v) -> v ?? throw e`, `f(s ?? throw e)`.
- The cs2gs migration tool can emit first-class throw-expressions instead of the
  `if`-block workaround (issue #914 follow-up).

### Neutral / Negative

- A new bottom type (`TypeSymbol.Never`) and bound/syntax node kinds are added;
  the coverage-matrix golden, exhaustiveness allowlists, tree visitors, printer,
  and spiller are updated accordingly. `Never` is internal to throw-expression
  flow and is never a user-writable type.

## Alternatives considered

- **Allow `throw` only inside `??` / ternary as a special syntactic case.**
  Rejected: a single bottom-typed expression node composes uniformly through the
  conversion and common-type machinery and matches C#'s model with less special
  casing.
- **Lower throw-expressions to an `if`-block in the binder (status quo of
  cs2gs).** Rejected: not an expression, doesn't compose as a `??`/ternary
  operand, and produces less faithful IL/source.
