# ADR-0075: `(T) -> R` as the canonical function-type clause syntax

- **Status**: Accepted
- **Date**: 2026-06-19
- **Phase**: Phase 9 — language depth / control-flow polish
- **Related**: parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish), this ADR [#715](https://github.com/DavidObando/gsharp/issues/715), paired with ADR-0074 [#714](https://github.com/DavidObando/gsharp/issues/714) (arrow lambda + `:` switch arms), interacts with [#716](https://github.com/DavidObando/gsharp/issues/716) (lambda parameter-type inference); reuses `RightArrowToken` (ADR-0050)

## Context

ADR-0074 (issue #714) repurposed `->` (`RightArrowToken`) as the lambda
operator: `(x int32) -> x * x` is now the canonical anonymous-function
expression. That ADR explicitly left the **type** of such a value
unchanged. To declare a variable that holds a `(x int32) -> x * x`
lambda you still wrote the legacy spelling:

```gs
var square func(int32) int32 = (x int32) -> x * x
```

The asymmetry between the expression form (`(x int32) -> x * x`) and
the type spelling (`func(int32) int32`) is exactly the gap newcomers
from Kotlin (`(Int) -> Int`), Swift (`(Int) -> Int`), TypeScript
(`(x: number) => number`), Scala, F#, and Rust (`fn(i32) -> i32`)
flag immediately — there is no other modern language where the lambda
operator and the function-type operator disagree on shape. The legacy
`func(T) R` shape also reads ambiguously next to a function
**declaration** (`func name(T) R { … }`) and next to a function
**literal** (`func(T) R { … }`): only its position in the grammar
distinguishes the three.

This ADR closes the gap by making the function-type clause spell the
same arrow shape as the lambda expression. Function declarations and
function literals keep the `func` keyword — only the *type-clause*
spelling changes.

## Decision

### 1. Canonical function-type clause grammar

```
function-type-clause :=
    [ 'async' ] '(' parameter-type-list? ')' '->' return-type-clause

parameter-type-list :=
    type-clause (',' type-clause)*

return-type-clause :=
    type-clause                          // any type, including a
                                         // tuple-type clause for
                                         // multi-return shapes:
                                         //   () -> (T1, T2)
                                         //
                                         // void is spelled as the
                                         // type-identifier `void` —
                                         //   () -> void
```

Examples:

```gs
var op       (int32, int32) -> int32        = (a int32, b int32) -> a + b
var addTen   (int32) -> int32               = (x int32) -> x + 10
var greet    () -> void                     = () -> Console.WriteLine("hi")
var splitter (string) -> (string, int32)    = split
var cb       async (int32) -> int32         = async func(x int32) int32 { … }

func apply(f (int32) -> int32, v int32) int32 { return f(v) }
func makeAdder(delta int32) (int32) -> int32 { return (x int32) -> x + delta }
```

Concrete decisions:

- **Parameter list is always parenthesized.** Zero, one, and many
  parameter slots all read the same. The single-parameter shorthand
  `T -> R` is **not** in scope — type clauses must be unambiguous in
  every position they appear (variable types, parameter types, return
  types, generic type arguments, `let`/`var` initializer types,
  `if let` / `guard let` type clauses), and a leading identifier
  followed by `->` would collide with the lambda-expression rule in
  expression position.
- **Multi-return shapes spell their return slot as a tuple type
  clause.** `() -> (int32, string)` is a function that returns a
  two-element tuple. This composes with ADR-0049's tuple types: the
  parser already understands `(T1, T2, ...)` as a tuple-type clause,
  and the return-type slot is a regular type clause that delegates to
  the same `ParseTypeClause` entry point.
- **`void` is a valid return-type spelling.** `() -> void`,
  `(int32) -> void`, etc. produce a `FunctionTypeSymbol` whose return
  type is `TypeSymbol.Void`. The binder's `LookupType` recognises
  `void` as the type-clause-position spelling of the void return
  type. Outside a function-type return slot, `void` continues to be
  rejected — a parameter, a local, or a field cannot be typed `void`.
- **`async (T) -> R` lowers to `(T) -> Task[R]` (or `(T) -> Task` when
  the return is `void`).** This matches the existing lowering of the
  legacy `async func(T) R` type clause: the binder strips the async
  modifier and synthesises a `FunctionTypeSymbol` over the awaited
  type. No new bound-tree shape is needed.

### 2. Disambiguation strategy

The only new lookahead question is: when the parser sees a `(` in a
**type-clause position**, is the upcoming shape a parenthesised tuple
type (`(int32, string)`) or a function type (`(int32) -> string`)?

The parser disambiguates with bounded look-ahead, mirroring the rule
ADR-0074 introduced for lambda expressions:

1. Find the matching `)` for the leading `(`, counting nested
   `()` / `[]` / `{}` only (string-interpolation holes are tokenised
   into separate tokens upstream).
2. If the token immediately following the `)` is `->`, the parser
   commits to a function-type clause and parses the return type next.
3. Otherwise, the parser falls back to a tuple-type clause —
   `(int32, string)` continues to parse exactly as it does today.

The lookahead never crosses a statement terminator and never
speculatively binds. It runs only in type-clause positions; in
expression positions, a `(` continues to mean a parenthesised
expression, a tuple literal, or (post ADR-0074) the start of a
lambda. Type-clause and expression contexts never overlap.

The async modifier defers to the same rule: `async (T) -> R` matches
when the parser is already in a type-clause slot and has consumed
`async`; the trailing `(...)` runs through the same arrow-lookahead.

This decision composes cleanly with the existing call-site
named-argument syntax (`Call(name: value)`, named-arg `:` is per
ADR-0064 / ADR-0050 etc.), with the switch-arm `:` (ADR-0074), and
with `if let` / `guard let` type clauses (ADR-0071) — none of those
positions accept a function-type clause without an enclosing type-
clause introducer (`var`, `let`, parameter type, return type, generic
argument), so there is no shared ambiguity surface.

### 3. Old `func(T) R` spelling deprecated for one release

The legacy `func(T) R` type-clause shape **still parses** for this
release. The parser reports a new warning diagnostic on the leading
`func` keyword when it sits in a type-clause position:

| Code     | Severity | Message                                                                                                                                  |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------|
| `GS0303` | Warning  | `'func(...)' function-type clauses are deprecated; use '(T) -> R' instead (ADR-0075).`                                                   |

Both spellings produce an identical `FunctionTypeSymbol` — the same
parameter types, the same return type, the same async lowering, the
same identity (`FunctionTypeSymbol.Get` interns by the canonical
arrow display). A lambda or method-group expression that converts to
one spelling converts equivalently to the other; the warning is the
only observable difference between the two forms.

GS0303 fires once per *occurrence* of the legacy `func` keyword in a
type-clause position, not per file. A program that mixes both shapes
will see exactly as many GS0303 warnings as it has legacy spellings,
which the IDE / formatter can drive to zero mechanically.

The legacy spelling is removed in **one** subsequent release. Until
then GS0303 is the canonical signal for documentation / sample /
golden drift back to the old form.

### 4. Function declarations and function literals are unchanged

- **Function declarations** keep `func`:
  ```gs
  func add(x int32, y int32) int32 { return x + y }
  async func fetchAsync(url string) string { … }
  ```
- **Function literal expressions** keep `func`:
  ```gs
  var f = func(x int32) int32 { return x * x }
  var g = async func(x int32) int32 { return x + 100 }
  ```
- **Trailing-`func` lambda sugar** (multi-line trailing-function-call
  bodies — Phase 4.9, PR #74) is **untouched**. Only the type-clause
  spelling moves to `(T) -> R`.

### 5. Interaction with ADR-0074

ADR-0074 made `(x int32) -> x * x` a lambda **expression**. ADR-0075
makes `(int32) -> int32` a **type clause**. The two never share a
position:

- A lambda expression appears in expression context. Its parameter
  list is `(identifier type-clause, …)` and the `->` is followed by a
  body (an expression or a `{ … }` block).
- A function-type clause appears in type-clause context. Its
  parameter list is `(type-clause, …)` (no identifiers) and the `->`
  is followed by a type clause.

A program declaring `var op (int32, int32) -> int32 = (a int32, b int32) -> a + b`
is parsed as: variable name `op`, function-type clause
`(int32, int32) -> int32`, equals, lambda expression
`(a int32, b int32) -> a + b`. The type-clause parser and the lambda
parser agree on the `(` lookahead rule (matching `)` followed by
`->`) but commit to different productions because the surrounding
context disambiguates which one is allowed.

ADR-0074's switch-arm `:` migration is wholly unrelated — switch arms
sit inside `switch { … }` bodies that never contain a type clause,
and function-type clauses cannot appear in pattern position.

### 6. Migration

This release ships with **both** type-clause shapes accepted. Samples,
tests, website docs, the tour, tutorials, the spec EBNF appendix, and
the diagnostics reference all migrate to `(T) -> R` in this PR. The
deprecated `func(T) R` form is removed in **one** subsequent release;
until then `GS0303` is the canonical signal for sample / golden /
documentation drift back to the old form.

## Consequences

Positive:

- The lambda expression and the function-type clause finally agree on
  shape — the lambda `(x int32) -> x * x` reads as an inhabitant of
  the function type `(int32) -> int32`, exactly as in Kotlin / Swift /
  TypeScript / Rust.
- One fewer place where `func` is overloaded: the keyword now appears
  only in *declaration-like* positions (top-level function decls,
  method decls inside types, function literals, trailing-`func`
  lambda sugar). Type positions no longer borrow `func`.
- No new bound-tree shape. Both spellings produce the same
  `FunctionTypeSymbol`, so emit, the interpreter, lowering, the
  rewriter, the walker, the printer, the spill spiller, and the
  exhaustiveness allowlists need no per-pass changes.
- The deprecation window is observable through `GS0303`, so existing
  programs that compile today continue to compile and surface their
  migration path through the diagnostic stream rather than failing.
- The disambiguation rule for `(` in type-clause position is the
  exact same rule the lambda parser already uses for expression
  position, so users only have to learn one lookahead heuristic.

Negative:

- Two function-type-clause spellings are accepted for one release.
  Style is enforced through `GS0303`; the formatter will rewrite
  `func(...) R` to `(T) -> R` once the formatter feature exists.
- The `(` lookahead in type-clause position now has two possible
  productions (tuple type vs. function type). The lookahead is
  bounded, deterministic, and identical to the existing lambda
  lookahead — no new parsing complexity class — but it does mean
  type-clause parsing is no longer a single-token decision.

Neutral:

- The `RightArrowToken` keeps its existing token kind; no lexer
  change. The `FuncKeyword` keyword keeps its existing kind; it is
  simply no longer expected in type-clause positions.
- Hover / completion (the language server) renders function types in
  the canonical arrow form. The legacy display
  (`func(int32) int32`) is gone from the user-facing surface,
  matching what diagnostics already do.

## Alternatives considered

### A. Keep `func(T) R` and stop here

Considered and rejected. ADR-0074 already commits the language to the
arrow operator for anonymous functions; leaving the type spelling
behind makes the language harder to read (the lambda and its declared
type disagree on shape) and prevents the formatter from emitting a
single canonical surface.

### B. `fn(T) -> R` (Rust-style) or `func(T) -> R`

Considered. `fn` is not a G# token and adding it solely to keep a
keyword in the type spelling re-creates the asymmetry this ADR is
removing. Keeping the legacy `func(T) -> R` (arrow + keyword) is
strictly worse than dropping the keyword: it is a longer spelling
that conveys no extra information, while still differing from the
lambda expression's `(T) -> R` shape.

### C. `(T1, T2) => R` (C# / TypeScript-style)

`=>` is not currently a token in G# (see ADR-0074 §B). Adding it
solely for function types would burn a new two-character punctuator,
and choosing between `=>` and `->` was already settled in favour of
`->` when the lambda operator was decided. Using a different arrow
in the type vs. the lambda would recreate the symmetry break this
ADR is closing.

### D. Drop the deprecation window and make the change a hard error

Considered and rejected. The legacy spelling appears in third-party
code, in older blog posts and samples, and in checked-in code that
this PR cannot reach. A one-release warning gives users a mechanical
migration path and matches how ADR-0074 handled the switch-arm `->`
deprecation in the same release.

### E. Allow the single-parameter shorthand `T -> R`

Considered and deferred. The shorthand is convenient but introduces
ambiguity with `T -> R` reading as an unrelated binary form, in much
the same way the single-parameter lambda shorthand `x -> body` was
deferred in ADR-0074 §C. Deferring keeps every function-type clause
parenthesised and consistent with the lambda parameter list, and
leaves the door open for `T -> R` shorthand if a future ADR decides
the ergonomics are worth it.

### F. Wait for parameter-type inference (#716) before changing the type spelling

Considered and rejected. The two changes are independent: type-clause
spelling is a parser change in *type-clause* positions, while
parameter-type inference is a binder change in *lambda parameter*
positions. Shipping the arrow type spelling now and growing
inference in #716 are strict-superset changes — no syntactic regret
cost.
