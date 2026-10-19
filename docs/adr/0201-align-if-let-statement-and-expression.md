# ADR-0201: Align the statement and expression forms of `if let`

- **Status**: Accepted (maintainer decision on issue #4961, 2026-10-17)
- **Date**: 2026-10-17
- **Phase**: Phase 8 — language ergonomics / expression surface
- **Amended by**: [ADR-0202](0202-one-rule-for-block-tails-and-arrow-bodies.md)
  for block-tail types and discarded/void expression contexts; the shared
  header rules here are unchanged.
- **Supersedes**: in [ADR-0151](0151-if-let-expressions.md), semantics item 9
  and the last paragraph of "The `&&` delimiter rule" (the statement form
  keeping the full expression grammar). In
  [ADR-0071](0071-if-let-and-guard-let-bindings.md), the statement-form
  `if let` evaluation rule ("evaluates every initializer left to right before
  one combined nil test") and the rows of the ADR-0151 addendum table that
  differ for that reason. In
  [ADR-0163](0163-while-let-loop-condition-bindings.md), the reason given for
  rejecting a `while let` guard ("statement-form `if let` has no such
  delimiter").
- **Related**: issue [#4961](https://github.com/DavidObando/gsharp/issues/4961),
  follow-up [#4968](https://github.com/DavidObando/gsharp/issues/4968)
  (`while let` / `guard let` guards), ADR-0069 (smart-cast narrowing),
  ADR-0154 (discriminating tests)

## Context

`if let` has a statement form (ADR-0071) and a value-producing expression form
(ADR-0151). The two shared the binding-clause grammar and the nullable-strip
rules but differed in ways a user cannot predict from the syntax:

```gsharp
func HasText(value string?) bool {
    if let text = value && text.Length > 0 {   // GS0157: Cannot find type text
        return true
    }
    return false
}
```

The same header in value position (`return if let text = value && … { … } else { … }`)
binds `value` and guards on `text.Length > 0`. In the statement form the `&&`
was swallowed into the initializer, so `text` was referenced outside its scope
and the generic unknown-name path reported GS0157. The maintainer decided that
the two forms must behave the same.

### Inventory of differences before this ADR

| # | Aspect | Statement form | Expression form |
| --- | --- | --- | --- |
| 1 | Initializer grammar | Full expression grammar; a top-level `&&`/`\|\|` belongs to the initializer | Stops at a top-level `&&`/`\|\|`; `??` tail accepted; a `?:` initializer failed to parse |
| 2 | Guard clause | None (`&& g` swallowed; bound name in `g` → GS0157) | Optional `&& <bool>` after the final binding |
| 3 | Multiple bindings: evaluation | Every initializer evaluated, then one combined nil test | Left-to-right short circuit; the first `nil` skips the rest |
| 4 | Later initializer sees an earlier binding | In scope but **not narrowed** (`let n = Len(a)` → GS0154/GS0159) | Narrowed to its non-null type |
| 5 | Non-nullable later initializer (`let u = t.ToUpper()`) | Hidden behind #4 (GS0159) | GS0296 |
| 6 | `else` | Optional; any statement, including `else if` / `else if let` | Mandatory (GS0276); block, `if` or `if let` expression |
| 7 | Branch bodies | Statements | Blocks whose tail is a value (GS0277); tails unify (GS0263) |
| 8 | Scope of bound names | Later initializers, then-block; never else or after | Later initializers, guard, then-block; never else or after |
| 9 | Narrowing of bindings in the then-region | Yes | Yes |
| 10 | Narrowing / pattern variables from the guard | n/a (no guard) | None (`&& o != nil` did not narrow `o`; `&& o is T t` left `t` unusable, GS0532) |
| 11 | Diagnostics | GS0296 | GS0296, GS0276, GS0277, GS0263, guard conversion (GS0155) |
| 12 | Lowering | `BoundBlockStatement` + `BoundIfStatement` (+ matched flag) | `BoundBlockExpression` + `BoundConditionalExpression` |
| 13 | gsfmt | Token-based; no form-specific rule | Same |
| 14 | cs2gs printer | Initializers printed at the logical-and+1 tier (parenthesized); never emits a guard | Same initializer rule; emits a guard |
| 15 | LSP (hover, definition, semantic tokens) | Binding clause is the declaration syntax | Same |

## Decision

Both forms use one header grammar and one binding/scoping rule. Only the
differences that follow from statement versus value position remain.

```ebnf
IfLetStmt        = "if" LetBindingHeader Statement ( "else" Statement )? .
IfLetExpression  = "if" LetBindingHeader BlockExpression
                   ( "else" ( IfExpression | IfLetExpression | BlockExpression ) )? .
LetBindingHeader = LetBindingList ( "&&" Expression )? .
LetBindingList   = LetBindingClause ( "," LetBindingClause )* .
LetBindingClause = "let" identifier TypeClause? "=" LetInitializer .
```

An expression that must produce a value requires `else`; ADR-0202 permits its
omission when the expression is discarded and its result is `void`.

### 1. Initializer rule (both forms, every `let`-binding header)

A binding initializer is the full expression grammar except that a
**top-level** `&&` or `||` ends it. Everything below the logical-and tier
is kept: an assignment (`if let v = cached = Next()`, whose right-hand side
follows the same rule), the right-associative `??`, and the `?:` conditional,
whose false arm follows the same rule (so a guard may follow it).
A logical operator that belongs to the initializer is parenthesized:

```gsharp
if let v = a ?? b && v.Length > 0 { … }          // initializer `a ?? b`
if let v = flag ? x : y && v.Length > 0 { … }    // initializer `flag ? x : y`
if let v = (a && b ? x : y) { … }                // parenthesized: one initializer
```

The rule is implemented once, in `Parser.ParseIfLetHeader`, which every
`let`-binding form (`if let` statement and expression, `guard let`,
`while let`) calls. The initializer is not parsed by a re-implemented
"restricted" grammar. `ParseExpression(stopAtTopLevelLogical: true)` uses the
ordinary assignment, conditional, range, coalescing and binary parsers. The
binary loop stops before `&&` or `||` in this context. Assignment values,
coalescing tails and conditional false arms continue in the same context;
nested expression entries (parentheses, arguments, lambdas, conditional true
arms, and so on) reset it and use the full grammar. The previous context is
restored on exit. Initializers and guards are each parsed once, including
interpolation holes and unsupported `while let` / `guard let` guards. No
speculative reparse, syntax-tree delimiter walk, or parse memo is required.

### 2. Guard

A single top-level `&&` after the final binding introduces a `bool` guard in
both forms. It is evaluated only after every binding matched, sees all bound
names narrowed, and a `false` guard selects the `else` branch (or skips the
then-block when there is none).

### 3. Evaluation order

Both forms evaluate bindings left to right and short-circuit on the first
`nil`: later initializers and the guard do not run. Each initializer runs at
most once. This replaces ADR-0071's eager statement-form rule.

### 4. Scope and narrowing

The bound names are in scope in later initializers, in the guard, and in the
then-region, and nowhere else: not in the `else` branch and not after the
form. Each binding joins one narrowing frame as soon as it binds, so a later
initializer, the guard and the then-region all see earlier bindings at their
non-null underlying types. The scope and frame are managed by one helper,
`IfLetBindingSupport.BindHeader`, that both binders call.

The then-region sees the guard the way an `if` branch sees its condition, in
both forms: the narrowing a `true` guard implies (`&& other != nil`,
`&& value is Name`) and the guard's when-true pattern variables
(`&& o is string text`) are in scope there. Each form uses its existing
`if`-condition classifier (`ClassifyIfConditionNarrowing` for the statement,
`ClassifyIfExpressionNarrowing` for the expression), so the guard narrows
exactly as the same condition would after `if`.

For name uses in these regions, the language server uses the compiler semantic
model's selected symbol before its syntax-based fallbacks. Pattern flow scope
and inner declarations, including tuple-loop locals, therefore follow the same
binder decision as compilation. Member-receiver fast paths retain the name's
syntax anchor so these uses participate in that lookup too. Bare delegate
callees are anchored on their identifier, independently of the invocation's
method symbol. The shared `BoundSemantics` accessor introduced by #4995
prefers that exact token anchor before its expression fallback. The script
binding pass excludes identifiers already mapped from a function body before
its by-name matching. Binding-clause identifiers require an exact syntax
match, so an unmapped function declaration cannot consume a script binding
through that fallback either.

### 5. Every binding strips one nullable layer

A later initializer that is already non-nullable (`if let t = s, let u =
t.ToUpper()`) is **GS0296** in both forms. A binding means "this may be
`nil`"; a non-nullable value belongs in a plain `let` in the then-region. The
alternative (accepting a non-nullable later initializer as a plain binding) was
rejected because it would make `if let` silently accept a typo'd or
mistyped initializer that the author believed could be `nil`.

### 6. Diagnostics

| Code | When |
| --- | --- |
| GS0296 | An initializer is not nullable (unchanged). |
| **GS0624** | A guard leaves a non-nullable `bool` initializer, or an unparenthesized assignment/coalescing/conditional continuation hides that boolean behind a nullable conversion. Parenthesize the entire initializer to make its boundary explicit. |
| **GS0625** | `guard let` or `while let` has a `&& guard`; only `if let` supports one (follow-up #4968). Reported by the parser, so the `&&` never leaks into the initializer and no GS0157 follows. |
| **GS0626** | A top-level `\|\|` follows a binding list. Only `&&` introduces a guard. |
| GS0155 | The guard does not convert to `bool` (unchanged; now also for the statement form). |

### 7. Remaining differences (statement versus value position only)

| Aspect | Statement form | Expression form | Reason |
| --- | --- | --- | --- |
| `else` | Optional; any statement | Required for a value (GS0276); optional when discarded (ADR-0202) | A value position needs a value on every path |
| Branch bodies | Statements | Value or terminal `never` tails; `void` when discarded (ADR-0202), unified (GS0263) | Context determines whether a value is required |
| Lowering | Nested `BoundIfStatement`s, or forward conditional gotos to one else label | `BoundConditionalExpression` for a value; statement nodes for `void`, both over the shared short-circuit condition | A statement then-block can `return`, `break`, `continue`, `goto`, `yield`, `await` and capture; without an `else` it stays in plain statement nodes |

Without an `else` branch, or with a single test, the statement lowers to nested
statements:

```text
if let a = e0, let b = e1 && g { T }
=>
{ let a = e0; if a != nil { let b = e1; if b != nil && g { T } } }
```

With an `else` branch and more than one test it lowers to forward conditional
gotos to one else label:

```text
if let a = e0, let b = e1 && g { T } else { F }
=>
{
    let a = e0
    if a == nil goto <else>
    let b = e1
    if b == nil goto <else>
    if !g goto <else>
    T
    goto <end>
<else>:
    F
<end>:
}
```

This replaces ADR-0071's matched-flag shape (`var <matched> = false; …;
if !<matched> { F }`). Under that shape, return analysis could not see that a
statement whose arms both `return` always returns, so it reported GS0100.
Plain control flow exposes the branch structure to return analysis. A short-circuit
block-expression condition (the expression form's) was rejected here as well:
definite-assignment analysis cannot see through it that the then-branch runs
only after every initializer ran, so an `out` argument of a later initializer
was reported unassigned (GS0238).

Branch-exit nullability analysis treats a labelled bound block as internal
control flow, not an unconditional exit at its first `goto`. Without a CFG it
conservatively drops facts for roots that the block can assign and retains only
untouched entry facts. All branch statements use this shared analysis path, so
an enclosing `if` join cannot discard a live branch and prove a nullable local
non-null from the other branch alone.

### Not changed by this ADR

- **`while let` / `guard let`.** They share the header parser (so they get the
  initializer rule and GS0625/GS0626) but not the guard or the evaluation-order
  change; see #4968.

## Compatibility

The initializer rule changes the parse of a statement-form initializer whose
top level contains `&&` or `||`.

- `&&` and `||` are defined only on `bool` (`bool? && bool?` is GS0129), and a
  `bool` initializer is GS0296. So `if let x = p && q { … }` and
  `if let x = p || q { … }` were never valid, and `a ?? (b && c)` has type
  `bool` and was never valid either. G# has no user-defined `operator true` /
  `operator false`, so no imported operator makes `&&` produce a nullable.
- One previously valid shape is a `?:` initializer whose condition has a
  top-level logical operator: `if let v = a && b ? x : y { … }` with `x` and
  `y` nullable. It now parses as initializer `a` and guard `b ? x : y`. It
  never compiles silently: the `bool` initializer reports GS0624 (parenthesize)
  and the non-`bool` guard reports GS0155. The fix that preserves meaning is
  `if let v = (a && b ? x : y) { … }`.
- Assignment conversion or conditional unification can also hide the boolean:
  with `cached bool?`, `if let v = cached = a && b` previously stored `a && b`
  and entered the body even when false. Likewise, a nullable true arm in
  `flag ? fallback : false && b` can make the whole initializer nullable.
  Compound assignments such as `cached &= a && b` have the same ambiguity.
  GS0624 diagnoses these continuations instead of silently moving the logical
  operation outside them. Use `(cached = a && b)` or
  `(flag ? fallback : false && b)` to keep the original meaning, or parenthesize
  only the prefix assignment/conditional to make the new guard explicit.
  The check follows the parser's source assignment/coalescing/ternary
  continuations, then
  locates their final value by its bound syntax anchor, including inside
  synthesized assignment-result temporary initializers. It strips implicit
  conversions, but does not look through an explicit nullable cast or an
  ordinary source call. Nested `if`/`if let` expressions and parentheses close
  the source continuation even when their bound representation is another
  conditional or has no parenthesized node. Parentheses and `checked`/`unchecked`
  wrappers are unwrapped only to locate that whole value, never to resume the
  continuation. The contextual conversion funnel anchors the original branchy
  value before wrapping it, so binding-time queries do not depend on the later
  syntax-anchoring walk to recognize an implicit conversion. When target typing
  has converted a closed expression, the check covers every target-typed
  branchy result: `if`/`if let`/ternary, blocks, switch arms and coalescing.
  Every value arm must be boolean before implicit conversion; inspecting only
  one arm would mistake an intrinsically nullable expression for a boolean one.
  An untyped `default` arm has no intrinsic nullable type and cannot establish
  that the old continuation was non-Boolean; an explicitly nullable typed
  `default(T?)`, like an explicitly nullable cast, remains opaque.
  Coalescing reuses the ordinary operator binder to classify its present left
  value. An open coalescing tail is a source continuation even when its overall
  result is not boolean: with `cached object?`, `cached = value ?? false && b`
  can box the boolean tail before storing it.
- An assignment initializer (`if let v = cached = Next() { … }`) keeps
  working in every form; a guard may follow it.
- A `?:` initializer without a top-level logical operator
  (`if let v = flag ? x : y { … }`) keeps working, and now also works in the
  expression form, where it used to fail to parse.
- `guard let` and `while let` initializers follow the same rule; the same
  compatibility argument applies, and a guard reports GS0625.
- Evaluation order: a multi-binding statement whose later initializer has a
  side effect no longer runs that initializer when an earlier binding is `nil`.
  This is the behavior ADR-0151 already gave the expression form and Swift
  gives `if let`.

Repository count at the time of the change (`.gs` sources, test sources and
test inputs in string literals, samples, website docs, ADRs, cs2gs translator
and its tests): **one** statement `if let` with a top-level `&&` in an
initializer — the ADR-0151 parser test that pinned the old statement-form
behavior, rewritten by this change — and **zero** with a `?:` or assignment initializer.
There is **one** multi-binding statement `if let` in non-test source
(`samples/IfLetGuardLet.gs`), whose initializers are side-effect-free
parameters. cs2gs prints every statement-form initializer at the
logical-and-plus-one tier (`GSharpPrinter.IfLetInitializerPrecedence`), so a
translated `&&`, `||`, `??` or `?:` initializer is already parenthesized and
its output keeps its meaning.

## Consequences

- The issue's repro compiles in both forms, and the GS0157 cascade is gone for
  every `let`-binding form.
- The parser decides initializer termination and the guard in one routine, and
  the binders share one scope/narrowing helper, so the forms cannot drift
  again.
- cs2gs keeps nesting a C# guard inside the then-branch for the statement form:
  its output may be compiled by the pinned previous release (N-1 rule).
  Emitting the statement guard is a follow-up once a release containing it is
  the pin.

## Alternatives considered

- **Speculative full-expression parsing with a delimiter walk and memo.**
  Rejected: token splitting, other header forms and fresh interpolation-hole
  parsers bypassed progressively broader caches. A boundary in the ordinary
  binary loop removes the repeated work instead of caching individual shapes.
- **Keep the full grammar in the statement form and add a guard only after a
  parenthesized initializer.** Rejected: the same header would still mean two
  different things depending on position, which is the bug.
- **A different guard delimiter (`where`, `,`).** Rejected for the same reason
  ADR-0151 rejected it; the expression form already ships `&&`.
- **Silently re-parse `a && b ? x : y` with the old meaning.** Rejected: it
  would make one shape follow a different rule from every other, and the
  explicit parenthesized form is unambiguous.
- **Keep ADR-0071's matched-flag lowering for a multi-binding statement with
  an `else`.** Rejected: a `bool` flag hides from return analysis that the two
  arms are exhaustive (GS0100 on a both-arms-return statement, already present
  on `main`), whereas forward gotos keep the branch structure visible to every
  flow analysis. The emit tests run `return`, `continue`, `yield`, `await`,
  closures and out arguments through both lowerings.
