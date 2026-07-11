# ADR-0074: `->` for lambda expressions, `:` for switch-expression arms

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 9 — language depth / control-flow polish
- **Related**: parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish), this ADR [#714](https://github.com/DavidObando/gsharp/issues/714), supersedes [#411](https://github.com/DavidObando/gsharp/issues/411), paired with [#715](https://github.com/DavidObando/gsharp/issues/715) (function-type syntax) and [#716](https://github.com/DavidObando/gsharp/issues/716) (lambda parameter-type inference); reuses `RightArrowToken` (ADR-0050)

## Context

Until this ADR `->` (`RightArrowToken`) had a single use in G#: the
separator between a switch-expression arm's pattern and its result.

```gs
let label = switch v {
    case 0 : "zero"
    case >0: "positive"
    default: "negative"
}
```

The token was lexed, recognised in `ParseSwitchExpressionArm`, and printed
back in `BoundNodePrinter`. Nothing else in the grammar consumed it.

This left a yawning expressivity gap for anonymous functions. G# already
has the long-form **function literal** `func(x int32) int32 { return x * x }`
(Phase 4.7 — see `FunctionLiteralExpressionSyntax`, `BoundFunctionLiteralExpression`,
`LambdaBinder`), which carries the full apparatus we need from a lambda:
closure capture, async support, return-type binding, erased-delegate
adapter synthesis, parameter defaulting (ADR-0063), `ref struct` /
managed-pointer escape checks (ADR-0058). But the surface syntax is
ceremonious:

```gs
xs.Where(func(x int32) bool { return x > 0 })
                         .Select(func(x int32) int32 { return x * x })
```

Two- and three-line declarations dwarf a one-line projection. Newcomers
coming from C#, Kotlin, Swift, TypeScript, Java, Rust, Scala, and modern
JavaScript reach for `x -> x + 1` (or `(x) -> x + 1`, or `x => x + 1`) and
hit a parser error today. ADR-0050 (Proposed) sketched a "trailing-arrow
lambda" call form (`xs.forEach -> (x int32) { … }`) on top of the existing
trailing-lambda call syntax — that proposal was never implemented and is
superseded by this one. The arrow is now the lambda operator, full stop.

The release-cadence twin of that decision is what to do with the now-free
switch-arm separator. Switching arms over to `:` aligns G# with the
case-label conventions of nearly every C-family language (`case 1:`,
`case Foo:`) and is consistent with how G# already uses `:` elsewhere
(map entries, label-prefixed statements per ADR-0070, named arguments,
`if let` / `guard let` type clauses per ADR-0071). The colon is unambiguous
in switch-arm position because the parser only enters arm-parsing inside a
`switch { … }` body that has already committed to alternating
`case`/`default` keywords with terminator-then-expression payloads.

The old `->` arm form must keep parsing for one release so existing
samples, tests, and third-party code don't break overnight; this ADR
defines that as a one-release deprecation window with a dedicated warning
diagnostic.

## Decision

### 1. New lambda-expression form

Add a first-class lambda expression to the grammar:

```
lambda-expression :=
    '(' parameter-list? ')' '->' lambda-body

parameter-list :=
    parameter (',' parameter)*

parameter :=
    identifier type-clause [ '=' constant-expression ]

lambda-body :=
    | expression                            // single-expression body
    | '{' statement* expression? '}'        // block body (BlockExpression)
```

Examples:

```gs
let square     = (x int32) -> x * x
let greet      = () -> Console.WriteLine("hi")
let combine    = (x int32, y int32) -> x + y
let weight     = (m Model) -> {
    val raw = m.Mass * m.Density
    raw + m.Offset
}
xs.Select((x int32) -> x * 2)
xs.Where((x int32) -> { val parity = x % 2; parity == 0 })
```

Concrete decisions:

- **Parameter list is parenthesized, with a single-parameter shorthand.**
  The parenthesized form `(x) -> body` reads identically for zero, one,
  and many parameters. In addition, **issue
  [#932](https://github.com/DavidObando/gsharp/issues/932) added the
  single-parameter shorthand `x -> body`** as exact sugar for `(x) -> body`
  (one untyped parameter whose type is inferred from the target delegate
  via the #716 machinery). This is unambiguous: `->` is not an
  expression-level binary operator in G#, so `IDENT ->` at expression
  position cannot begin any other construct (function-type clauses
  `(T) -> R` are parsed in type context and the deprecated switch-arm
  `case v -> r` in pattern context). See revised alternative C below.
- **Parameter types are mandatory.** Lambda-parameter type inference
  ("target-typed lambdas") is explicitly the scope of [#716](https://github.com/DavidObando/gsharp/issues/716)
  and is left to that PR. Until #716 lands, every lambda parameter
  carries a type clause exactly as a `func(...)` literal does today
  (and so does each parameter of a method or a function declaration).
- **Body is an expression OR a block.** A single expression becomes
  the lambda's return value; a brace-delimited block is parsed as a
  `BlockExpression` (ADR-0064, issue #669) — statements followed by an
  optional trailing expression. The trailing expression, if any, is the
  return value; if absent, the lambda's return type is `void`.
- **Return type is inferred.** Whatever the body's type is, that is the
  lambda's return type. There is no syntactic position for an explicit
  return-type annotation on an arrow lambda; users who need one keep
  using the `func(...) R { … }` literal.
- **No `async` arrow lambdas in v0.** Async lambdas continue to use
  `async func(...) R { … }`. Pulling `async` into the arrow form
  requires deciding where the modifier sits (before the parens? after
  the arrow?) and threads through the async-iterator carve-out; that
  is a separate decision, deferred behind explicit user demand.
- **No `ref` / `out` / `in` / `scoped` / `...variadic` parameters in v0.**
  Same reasoning — the arrow lambda is for the common case. Users that
  need by-ref or variadic shapes keep `func(...) R { … }`.
- **Default-value parameters are supported** (`(x int32 = 0) -> x + 1`),
  reusing the lambda parameter-default-value pipeline from ADR-0063.
- **All existing function-literal machinery applies.** Closure capture,
  delegate-erased adapter synthesis (`CreateErasedFunctionLiteralAdapter`),
  managed-pointer / ref-struct escape checks, and the
  `BoundFunctionLiteralExpression` contract are all reused — the binder
  desugars `LambdaExpressionSyntax` into a `BoundFunctionLiteralExpression`
  with a synthesized body block, so no new bound-node kind is introduced
  and emit / interpreter / lowering / rewriter / printer dispatch all work
  unchanged.

### 2. Switch-expression arms switch to `:`

```
switch-expression-arm :=
    | 'case' pattern ':' expression
    | 'default' ':' expression
```

The pre-existing `->` form is **still parsed** for this release, but the
parser reports a new warning diagnostic at the `->` token:

| Code     | Severity | Message                                                                                              |
|----------|----------|------------------------------------------------------------------------------------------------------|
| `GS0302` | Warning  | `'->' in a switch-expression arm is deprecated; use ':' instead (ADR-0074).`                          |

Both forms produce an identical bound tree (the `SwitchExpressionArmSyntax`
node continues to carry one separator token; only its `Kind` differs). The
binder, exhaustiveness analyzer, lowering passes, emitter, and interpreter
require no changes.

The **switch-statement** form is unchanged. Its arm shape was always
`case pattern { body-block }` — there was never an arrow involved — and
adopting `case pattern: { body-block }` for visual parity with the
expression form is out of scope for this PR. A later ADR may revisit the
separator on the statement form for parallelism.

### 3. Disambiguation strategy

The only potentially ambiguous lookahead in the grammar is a `(` at the
start of a primary expression, which today is either a parenthesised
expression or a tuple literal. The parser disambiguates with bounded
look-ahead **without** speculative parsing:

1. Find the matching `)` for the leading `(` (counting nested
   `()` / `[]` / `{}` only — string interpolation holes are tokenised
   into separate tokens upstream).
2. If the token immediately following the `)` is `->`, the parser
   commits to a lambda.
3. Inside the parens, an empty list (`()`) is unambiguous; a non-empty
   list must start with an identifier followed by a token that could
   begin a type clause (i.e. **not** `,`, `)`, or `=`). Otherwise the
   shape is not a parameter list, and the parser falls back to parsing
   a parenthesised / tuple expression — even if `->` happens to follow,
   in which case `->` would surface as a parse error at expression
   level (correctly: arrow can only follow a parameter list).
4. Inside a switch-expression arm, the parser accepts either `:` or
   `->`; on `->` it records `GS0302` and continues. The colon parses
   identically to its long-standing use in label-prefixed statements,
   map entries, named arguments, and `if let` type clauses — switch-arm
   `:` separates a pattern from an expression and never sits inside a
   nested expression context that could compete (the surrounding
   `switch { … }` body has already committed to alternating
   `case`/`default` heads).

Interaction with `if let` / `guard let` (ADR-0071): those forms use `:`
inside a type clause for the binding (`if let x: int32? = expr`). The
switch-arm `:` is not in a type-clause position; the two never share a
parsing context. Likewise the named-argument `:` (`Call(name: value)`) is
constrained to argument lists by the existing parser path and cannot
appear in pattern position.

### 4. Migration

This release ships with **both** arm forms accepted. Samples, tests,
website docs, the tour, tutorials, the spec, and the diagnostics reference
all migrate to `:` arms in this PR. The deprecated `->` form is removed in
**one** subsequent release; until then `GS0302` is the canonical signal
for sample / golden / documentation drift back to the old form.

## Consequences

Positive:

- High-frequency anonymous-function call sites collapse from
  `func(x int32) int32 { return x * x }` to `(x int32) -> x * x`.
- Newcomers' instinct (`x -> y` / `(x) -> y`) finally works.
- No new bound-node kind is introduced — the binder lowers
  `LambdaExpressionSyntax` into the existing
  `BoundFunctionLiteralExpression`, so every downstream consumer
  (emit, interpreter, lowering, rewriter, walker, printer, spill
  spiller, exhaustiveness allowlists) continues to work without
  per-pass changes.
- Switch-expression arms now read like every other C-family case
  label: `case Pattern: value`.
- `:` is consistent with G#'s existing uses (`map[K,V]{k: v}`, named
  arguments, label statements, `if let x: T?`) — programmers do not
  have to learn a new separator.
- The deprecation window is observable through `GS0302`, so existing
  programs surface their migrated form via the diagnostic stream
  rather than failing to compile.

Negative:

- Two switch-arm shapes are accepted for one release. Style is enforced
  through `GS0302`; the formatter will rewrite `->` to `:` once the
  formatter feature exists.
- ADR-0050's "trailing-arrow lambda" proposal is now superseded. That
  ADR is marked Superseded by ADR-0074 in this PR — the trailing-lambda
  call form still exists in its `func(...)` shape (Phase 4.9, PR #74).
- Today's arrow lambda has no async / `ref`-kind / variadic shape, so
  some call sites still reach for `func(...) R { … }`. This is by design
  for v0; widening is deferred to issue-driven follow-ups.

Neutral:

- The `RightArrowToken` keeps its existing token kind; no lexer change.
- Pattern parsing is unchanged. The arm parsers (statement and
  expression) are the only places that grew a new separator branch.

## Alternatives considered

### A. Make `->` the arrow lambda **and** keep `->` for switch arms

Considered and rejected. The token would still parse in both positions,
but the cognitive overload of "the arrow means one thing inside a switch
body and a different thing everywhere else" is exactly the kind of
ambiguity newcomers cite as a smell. Migrating arms to `:` is a small,
mechanical change with a one-release deprecation; the long-term shape
of the language is cleaner.

### B. Use `=>` as the lambda operator (C# style)

`=>` is not currently a token in G# (`>=` and `>` are, but not `=>`).
Adding it solely for lambdas would burn a new two-character punctuator,
and the user community's poll on the issue trended toward `->` as the
already-known token. Re-using `->` keeps the lexer untouched and frees
us from picking between `=>` and `->` later.

### C. Single-parameter shorthand `x -> body`

Considered and rejected for v0, then **adopted in issue
[#932](https://github.com/DavidObando/gsharp/issues/932)**. The original
v0 concern was a feared ambiguity with `name -> expr` reading as a binary
expression. In practice that ambiguity does not exist: `->` is never an
expression-level binary operator in G#, so a bare `IDENT ->` at
expression position is otherwise always a parse error. With target-typed
lambda parameters delivered by #716, the shorthand became pure sugar for
the parenthesised single-parameter form `(x) -> body` — one untyped
parameter inferred from the target delegate — and is now accepted at
primary-expression position. The parser commits to a lambda the moment it
sees `IDENT ->`; the parenthesised form remains the canonical spelling
for zero- and multi-parameter lambdas.

### D. Arrow-lambda body forced to `{ … }` block

Considered. The brace-only body is unambiguous but loses the one-liner
case that motivates the whole change. Both forms are common in Kotlin,
Swift, and Scala; allowing both gives short projections their natural
form and reserves `{ … }` for cases that genuinely have local statements.

### E. Migrate switch-statement arms to `case pattern:` too

Out of scope for this PR. Statement arms have always carried a brace
block (`case 1 { … }`), so they never had an arrow to deprecate. Whether
to grow a `:` between pattern and block (`case 1: { … }`) is a separate
parallelism question that can be answered without affecting this PR.

### F. Wait for parameter-type inference (#716) before shipping arrow lambdas

Considered. Inferring `x -> x * 2` is the longer-term lookable shape, but
holding the arrow back makes the parser still reject the user's first
attempt today. Shipping arrow lambdas with mandatory type annotations
now, and adding inference in #716 as a strict superset, is a smaller
step with no syntactic regret cost — the typed form continues to work
once inference lands.
