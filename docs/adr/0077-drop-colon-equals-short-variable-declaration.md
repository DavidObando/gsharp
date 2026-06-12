# ADR-0077: Drop `:=` short variable declaration

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 9 — language depth / surface cleanup
- **Related**: parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish), this ADR [#717](https://github.com/DavidObando/gsharp/issues/717), pairs with the type-decl grammar cleanup [#718](https://github.com/DavidObando/gsharp/issues/718). Supersedes ADR-0008 (Variable bindings — keep Go's `var`/`const`/`:=`, add `let`). Builds on ADR-0031 (canonical `for in`), ADR-0067 (fields require `var`/`let`), and ADR-0076 (lambda-binding type inference).

## Context

ADR-0008 inherited Go's binding surface — `var x = e` (mutable), `const x =
e` (compile-time constant), and `x := e` (short mutable declaration) — and
added `let x = e` (immutable runtime binding) for Swift / Rust ergonomics.
Three years on, the `:=` form is the **only** Go-flavoured binding
keyword in the language and it picks the *least safe* default at every
binding site: mutable, no type annotation, no syntactic signpost. Every
modern language in the comparison set (Swift, Kotlin, Rust, Scala, F#,
TypeScript, C#) uses two keywords to mark immutability vs. mutability
and forces the author to choose. ADR-0067 already ratified `var` /
`let` as the only spelling for fields (issue #366 / GS0288). Removing
`:=` from local statements collapses the binding-keyword surface to a
single, consistent triple — `let` / `var` / `const` — and removes the
perpetual "what's the difference between `:=` and `let`?" question
from G# onboarding.

ADR-0076 (lambda-binding type inference) is the final pre-requisite: it
makes `let f = (n int32) -> n * n` infer `f`'s type from the lambda
without re-typing it, so the "type repeats twice" objection to `let`-
over-`:=` no longer applies — the migration replacement `let x = e` is
exactly as terse as `x := e` was, and `var x = e` is one keyword longer
in exchange for an explicit mutability marker.

## Decision

### 1. Remove `:=` from every binding site

The short variable-declaration operator `:=` is removed from the
grammar at every position where it currently introduces a name. The
removal is **hard** — no deprecation window, no `--allow-legacy` knob.
The lexer continues to tokenise `:=` as `ColonEqualsToken` so the
parser can emit a single, precise diagnostic at the offending token
instead of cascading parse errors; otherwise `:=` is a parser-time
error wherever it appears.

The removed forms and their canonical replacements are:

| Removed form (legacy)                         | Canonical replacement                            |
| --------------------------------------------- | ------------------------------------------------ |
| `x := expr`                                   | `let x = expr` (default) or `var x = expr`       |
| `a, b := e1, e2`                              | `var a = e1` then `var b = e2` (one per line)    |
| `for i := 0; i < n; i++ { … }`                | `for var i = 0; i < n; i++ { … }`                |
| `for i := lo ... hi { … }`                    | `for i in lo ... hi { … }`                       |
| `for v := range coll { … }`                   | `for v in coll { … }` (ADR-0031)                 |
| `for k, v := range dict { … }`                | `for k, v in dict { … }` (ADR-0031)              |
| `await for v := range stream { … }`           | `await for v in stream { … }` (ADR-0031)         |
| `case v := <-ch { … }`                        | `case let v = <-ch { … }`                        |
| `if x := init; cond { … }`                    | `if var x = init; cond { … }`                    |

The `ParseSimpleStatement` helper that backs the for-clause and if-init
contexts grows two new acceptable shapes: a `var` declaration and a
`let` declaration. Both delegate to the existing `ParseVariableDeclaration`
machinery, so the binder, BoundTree, lowering, emit, and the
interpreter need no changes. The for-ellipsis form gains an `in`
spelling (`for i in lo ... hi`) that uses the same contextual `in`
token ADR-0031 introduced for `for v in coll`; the parser disambiguates
range vs. ellipsis by scanning ahead for the `...` token before the
body's `{`. The select-case bind form gains a `case let v = <-ch`
spelling that produces the same `SelectCaseKind.ReceiveBind` bound
node the legacy `:=` form did.

### 2. Choose `let` by default, `var` only when mutation is part of the algorithm

The migration recipe is: rewrite `name := expr` to `let name = expr`
unless the binding is later reassigned, mutated, or aliased in a way
that requires `var`. The compiler enforces this: `let` is read-only;
the existing `GS0143` "Variable 'name' is read-only and cannot be
assigned to" diagnostic fires on any reassignment and the author flips
the keyword to `var`. The repository-wide sweep (samples, tests, docs)
that ships with this ADR follows the same rule.

Lambda bindings benefit immediately from ADR-0076: the binding type
is inferred from the lambda's parameter list, so `let f = (n int32) ->
n * n` is a single-keyword spelling that loses nothing compared with
`f := (n int32) -> n * n`.

### 3. Diagnostic GS0305

The parser emits exactly one `GS0305` per occurrence of `:=` and
recovers locally so that follow-on statements in the same scope bind
cleanly. The diagnostic message is:

```
GS0305: ':=' short variable declaration has been removed; use 'let'
(immutable) or 'var' (mutable) instead (e.g. '<migration>') (ADR-0077).
```

The `<migration>` placeholder is context-specific:

- Standalone short-var-decl: `let x = …  or  var x = …`
- Multi-target short-var-decl: `var <firstTarget> = …  // one
  declaration per identifier`
- For-clause init: `let i = …  or  var i = …`
- For-ellipsis: `for i in lo ... hi`
- For-range (single): `for v in …`
- For-range (key/value): `for k, v in …`
- Await-for-range: `await for v in …`
- Select-case bind: `case let v = <-ch`
- If-init: `let i = …  or  var i = …`

The diagnostic's **location** is the `:=` token itself, not the
enclosing statement, so editor tooling highlights exactly the offending
operator and a quick-fix can replace just the two characters with the
chosen keyword.

### 4. Lexer behaviour

The lexer continues to recognise `:=` as `SyntaxKind.ColonEqualsToken`
and the token retains its existing position in `SyntaxFacts`. Keeping
the token alive is a deliberate diagnostic-quality decision: if `:`
and `=` were tokenised independently the parser would see two
unrelated tokens and surface a generic "unexpected '='" or
"expected identifier" diagnostic, which would scatter the user's
attention and bury the migration guidance. The single `ColonEqualsToken`
gives the parser a precise span to point at and a single, actionable
message to attach to it.

This is the same precedent used by ADR-0074 (kept `->` as `RightArrow`
even after the surface meaning changed) and ADR-0075 (kept the legacy
`func(T) R` shape for one release with `GS0303`).

### 5. Bound tree, emit, interpreter

No changes. Recovery rewrites the legacy syntax into the existing
canonical bound shape:

- `x := e` → `BoundVariableDeclaration(IsReadOnly = false, …)` —
  identical to the existing `var x = e` binding.
- `a, b := e1, e2` → the existing `BindMultiAssignmentStatement` path
  with the operator treated as `=`; the binder still walks the
  recovered tree and declares the targets (the `BoundBlockStatement`
  it returns is unchanged).
- `for v := range coll` and `await for v := range stream` → the
  existing `BoundForRangeStatement` / `BoundAwaitForRangeStatement`
  nodes (the parser synthesises an `in` token during recovery; the
  binder sees no difference).
- `for i := lo ... hi` and `case v := <-ch` → the existing
  `BoundForEllipsisStatement` and `BoundSelectStatement` shapes.

Because nothing downstream of the parser sees `ColonEqualsToken` any
more, BoundTree exhaustiveness, the rewriter, the walker, the
printer, the spill spiller, lowering, emit, and the interpreter need
no updates. The full test suite (both interpreter and compiler
back-ends) runs the existing fixtures unchanged.

### 6. Sample / test / doc sweep

Every `name := expr` (and every other removed form) in this repository
is rewritten in the same PR. The sweep covers:

- `samples/` (every `*.gs` file)
- `test/Core.Tests`, `test/Compiler.Tests`, `test/Interpreter.Tests`,
  `test/LanguageServer.Tests`
- `website/docs/` (tour, tutorials, spec, feature matrix, bridges,
  diagnostics, release notes, FAQ)
- `docs/` (lexical spec, grammar BNFs)
- ADR text in any document that references `:=` as part of an active
  language feature

The single exception is BNF / EBNF grammar notation that uses `:=` as
*meta-syntax* ("is defined as"); the meta-syntactic `:=` is not the
language operator and is left alone.

ADR-0008 is **superseded** by this ADR (status preserved for history;
the "Drop `:=`" alternative it considered and rejected is now the
accepted decision).

### 7. Documentation surface

The spec's operator table, the for-statement grammar, the select-case
grammar, the `await for` grammar, and the feature matrix all drop the
`:=` row / spelling and gain the `in` / `let` / `var` replacements.
The tour's basic-loops and concurrency pages, the C#-to-G# and
Go-to-G# bridge guides, the standard-library docs, and the
declarations-and-packages guide all migrate. The FAQ entry that
listed `:=` as a Go-inherited feature is rewritten to describe the
binding triple `let` / `var` / `const`. The release notes record the
removal under issue #717.

## Consequences

Positive:

- One binding triple — `let` / `var` / `const` — for every local and
  field. The "short" declaration is now `let x = expr` (one extra
  keyword) with explicit immutability semantics; the mutable form
  `var x = expr` is one extra keyword and explicit. No silent
  preference for the *least safe* default.
- Onboarding tax removed. Engineers coming from any modern language
  in the comparison set see exactly the binding surface they
  expect.
- The parser surface shrinks: every removed form previously needed a
  dedicated lookahead, parse helper, and (for for / select) a
  parallel AST branch carrying both the `:=` and the `in` shape. The
  recovery code path is a single line of synthesised-token wiring.
- One precise diagnostic per legacy occurrence; no cascades.
- Lambda bindings (`let f = (n int32) -> …`) lose nothing in
  terseness compared with `f := (n int32) -> …` thanks to ADR-0076.

Negative:

- Existing G# samples / scripts that were typed with `:=` need a
  one-time rewrite. This is mechanical (the migration rules above
  are pure syntactic substitution) and the repository-wide sweep in
  this PR proves it.
- Authors who liked the visual brevity of `x := 1` over
  `let x = 1` lose two characters. Mitigation: `let` is a single
  syllable and reads aloud as the binding it is; the cost is
  predictability for predictability.

Neutral:

- ADR-0067's "fields require `var`/`let`" rule (GS0288) is now a
  *consequence* of a single repository-wide policy rather than a
  field-specific carve-out.
- The lexer retains `ColonEqualsToken` indefinitely. The cost is one
  enum value and one lexer branch; the benefit is diagnostic quality
  for the foreseeable future.

## Alternatives considered

### A. Soft deprecation with a `GS0XXX` warning for one release

Considered and rejected. ADR-0075 took this path for `func(T) R`
because the canonical replacement (`(T) -> R`) was new in the same
release and authors needed migration time. `:=` has no such
constraint: `let` and `var` have shipped since ADR-0008, `for v in
coll` since ADR-0031, and lambda-binding inference since ADR-0076.
Every replacement form is already battle-tested. A deprecation
window would only extend the "two ways to spell a binding" period
that this ADR exists to end.

### B. Keep `:=` and rebind it to mean "immutable" (like `let`)

Considered and rejected. Repurposing existing syntax silently is the
single worst diagnostic strategy: every existing `:=` in third-party
code would change semantics with no compiler signal. Even with a
warning, the cognitive cost of "the same characters now mean the
opposite thing" is strictly worse than the migration cost of "the
characters no longer parse and the compiler tells you the
replacement."

### C. Keep `:=` only at statement position, remove from for/if/select

Considered and rejected. Half-removal is the worst of both worlds:
the binding-keyword surface stays at four (`let`, `var`, `const`,
`:=`), and the for / if / select forms grow an asymmetric
spelling rule. The repository-wide sweep is the same size either
way; the consistency win of "every binding site uses `let` or
`var`" is the entire point of the ADR.

### D. Remove `:=` and *also* require an explicit type clause on every binding

Considered and rejected. ADR-0076's lambda-binding inference and the
existing `var x = e` inference path are exactly the ergonomic G#
chose over verbose type-annotation requirements. Forcing
`let x int32 = 1` would punish the common case to satisfy a
formatter rule; it is not what this ADR exists to fix.

### E. Make `let` the *only* binding keyword (drop `var` too)

Considered and rejected. `let` and `var` together encode the single
most important property of a local — whether it is reassignable — at
the binding site, and the compiler enforces it. Folding both into a
single keyword either loses the immutability check (Go's path,
which this ADR is moving away from) or requires a separate
`#mutable` annotation that pulls the same information further from
the eye. The two-keyword split mirrors Swift / Kotlin / Rust /
TypeScript and is the documented best practice in the G# style
guide.
