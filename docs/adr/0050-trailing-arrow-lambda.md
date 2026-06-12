# ADR-0050: `->` arrow trailing-lambda syntax

- **Status**: Superseded by [ADR-0074](0074-arrow-lambda-and-colon-switch-arms.md)
- **Date**: 2026-05-28
- **Phase**: Phase 7 polish
- **Related**: issue #198, PR #74 (Phase 4.9 trailing-lambda), ADR-0023 (async state machine), ADR-0043 (`async func` type clause), [ADR-0074](0074-arrow-lambda-and-colon-switch-arms.md) (`->` repurposed as the lambda operator; this trailing-lambda-connector proposal is therefore no longer the way `->` is spent)

## Context

PR #74 introduced Phase 4.9 trailing-lambda call syntax: a `func(...) { body }` literal immediately following a call's closing paren is desugared into the last positional argument:

```gsharp
// Fully-expanded form (always valid)
runIt(func() int32 { return 42 })
combine(10, func(x int32) int32 { return x * 2 })
xs.forEach(func(x int32) { Console.WriteLine(x) })

// Phase 4.9 form
runIt() func() int32 { return 42 }
combine(10) func(x int32) int32 { return x * 2 }
xs.forEach() func(x int32) { Console.WriteLine(x) }
```

Issue #198 asks whether we can go further and allow shorter forms that omit the `func` keyword and explicit return type:

```gsharp
runIt -> { return 42 }
combine(10) -> (x int32) { return x * 2 }
xs.forEach -> (x int32) { Console.WriteLine(x) }
```

A full language analysis (see analysis document in the issue thread) evaluated three shorthand shapes—brace-only, param-list shorthand, and no-call-parens—both with and without an explicit connector token. Without a connector, all three shapes introduce parse ambiguities (brace-vs-block at statement level, param-list-vs-chained-call, and the no-parens form being fundamentally unresolvable). With `->` as the connector, every ambiguity dissolves because `->` at expression level is currently illegal in every context except inside a switch arm body.

The analysis also uncovered a pre-existing Phase 4.9 gap: `MaybeAppendTrailingLambda` does not handle `async func` trailing lambdas. That is tracked separately as issue #235.

## Decision

Introduce `->` (`RightArrowToken`, which is already lexed) as a trailing-lambda connector in expression position. The full grammar shape supported is:

```
trailing-arrow-lambda :=
    expression '->' trailing-lambda-body

trailing-lambda-body :=
    | [async] '{' statements '}'                           // zero-param implicit
    | [async] '(' ')' '{' statements '}'                   // zero-param explicit
    | [async] '(' param (',' param)* ')' '{' statements '}'  // one or more params

param := identifier type-clause
```

### Examples

```gsharp
// Zero-param sync — sole arg, no call-parens
runIt -> { return 42 }

// Zero-param sync — explicit empty parens (equivalent)
runIt -> () { return 42 }

// Named params, preceding regular args
combine(10) -> (x int32) { return x * 2 }

// Named params, no call-parens (member access)
xs.forEach -> (x int32) { Console.WriteLine(x) }

// Zero-param async
runIt -> async { return await computeAsync() }

// Named params async, preceding regular args
combine(10) -> async (x int32) { return await processAsync(x) }

// Named params async, no call-parens
xs.processEach -> async (x int32) { await handleAsync(x) }
```

All of the above are parser-level rewrites. The resulting bound tree is identical to passing an explicit `[async] func(params) returnType { body }` literal as the last positional argument.

### What the `->` form omits (and how it is recovered)

The Phase 4.9 explicit form requires the full function literal signature including return type:

```gsharp
runIt() func() int32 { return 42 }
```

The `->` form drops:

1. **The call's `()`** — when the lambda is the sole argument and there are no preceding regular arguments, the call parentheses may be omitted. The parser synthesizes a call with an empty regular-argument list.
2. **The `func` keyword** — `->` takes its role as the function-literal signal.
3. **The return type** — inferred from the expected type of the callee's last parameter.

### Return-type inference

When the binder processes a trailing-arrow lambda, it propagates the expected `func(P1, ..., Pn) R` type from the call site's resolved parameter into the lambda. The inferred return type `R` is applied to the lambda body. For async lambdas, `R` is the unwrapped return type (the binder applies `WrapAsTask(R)` to obtain the observable type, identical to existing `async func` literal handling in `BindFunctionLiteralExpression`).

If the callee is overloaded, the explicit parameter type annotations in the trailing lambda (`(x int32)`) provide enough type information to resolve the overload before inferring `R`. An ambiguity diagnostic is raised if multiple overloads match after parameter-type filtering.

### Relationship to Phase 4.9 (`func` keyword form)

Both forms are accepted by the compiler and produce identical bound trees. The `->` form is preferred style going forward; formatters and linters may flag the Phase 4.9 form as a style suggestion. The Phase 4.9 form is **not** deprecated at the compiler level — existing code continues to compile without change.

## Consequences

Positive:

- Eliminates the `func` keyword and return type from high-frequency trailing-lambda call sites, making DSL-style code significantly more readable.
- Enables the no-call-parens form (`xs.forEach -> (x int32) { ... }`) which was infeasible without the connector token.
- `->` is already in the lexer; no new token is introduced.
- The `async` qualifier (`-> async (params) { body }`) follows the same modifier-before-function convention as `async func`, keeping the mental model uniform.
- The fix for the Phase 4.9 async gap (issue #235) can land as a prerequisite patch with no dependency on this ADR.

Negative:

- Two syntactic spellings exist for the same thing (Phase 4.9 `func` form and `->` form), which may cause style divergence in multi-author codebases until formatter guidance is adopted.
- Return-type inference is a new binder capability (though bounded to trailing-lambda contexts). It adds a bidirectional type-flow step: the call site's expected parameter type must be resolved before the lambda body is bound.
- `->` was previously only seen inside switch arm bodies (originally `case X -> value`, now `case X: value` per ADR-0074). Encountering it at statement/expression level is a new context that readers must learn.

Neutral:

- The Phase 4.9 `func` keyword form is unaffected; no migration is required.
- Overload resolution is not materially harder: explicit parameter type annotations narrow the candidate set, and `R` is then inferred from the selected overload.

## Alternatives considered

### A. Brace-only, param-list, and no-call-parens forms without a connector token (as analysed in §3 of the issue #198 analysis)

Each shape introduces a distinct grammar ambiguity:

- **Brace-only** `call() { body }`: `{` at statement level is already a block statement; silently changing its meaning based on whether `)` precedes it on the same line requires whitespace significance, which GSharp does not have.
- **Param-list shorthand** `call(args) (params) { body }`: requires multi-token lookahead to the `{` and conflicts with chained call syntax `call(args)(args2)`.
- **No-call-parens** `forEach (params) { body }`: fundamentally inseparable from a regular call `forEach(arg1, arg2)` without type-system information at parse time.

All three were rejected in favour of the `->` connector, which resolves every ambiguity with a single token of lookahead.

### B. `async ->` prefix (Option B in the async analysis)

Placing `async` before `->` rather than after it (`runIt async -> { ... }`) was considered. Rejected because the phrase reads as "the arrow is async" rather than "the lambda is async", and because it requires recognising a two-token `async ->` sequence as a new syntactic unit. Option A (`-> async`) is more consistent with GSharp's existing `async func` convention where `async` precedes the function shape, not the call site.

### C. Inferring asyncness from `await` in the body (Option C)

Treating a lambda as async whenever its body contains an `await` expression was considered. Rejected because it conflicts with GSharp's explicit-modifier philosophy, requires a pre-pass over the lambda body before the parser can classify it, and produces surprising errors when `await` appears in a nested lambda.

### D. Introducing a dedicated lambda-expression syntax (`{ params -> body }`)

A Kotlin/Scala-style lambda expression where `{ }` unambiguously means "lambda" (not "block") was considered as a long-term alternative. This would also unlock the no-call-parens form without `->`. Deferred: it is a larger grammar change affecting struct literals, map literals, and block statements, and it would make `func` literals and lambda expressions two parallel syntactic forms. If a future usage survey reveals strong demand for the brace-only lambda shape at non-call-site positions (e.g., `var f = { x int32 -> x * 2 }`), this alternative should be revisited.

### E. Soft-deprecating Phase 4.9 immediately

Considered and rejected for this phase. The Phase 4.9 form has been in the language since PR #74 and is used in existing tests and code. Deprecating it now would break existing programs for a purely stylistic gain. If the `->` form achieves strong adoption, a later ADR can soft-deprecate the `func` keyword form with a formatter-enforced migration path.
