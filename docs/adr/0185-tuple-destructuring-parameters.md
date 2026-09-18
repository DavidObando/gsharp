# ADR-0185: Tuple-destructuring function-literal parameters

- **Status**: Proposed
- **Date**: 2026-09-18
- **Related**: ADR-0032 (deconstruction), ADR-0115 (cs2gs migration tool), ADR-0168
  (mixed deconstruction and discard bindings — the `let (a, b) = e` / `var (a, b)
  = e` statement-position mechanism this proposal extends into parameter
  position); ADR-0146 (anonymous-object literals — see Alternative 3 for why
  this ADR does not use them as the query-scope carrier); issue #3501
  (self-migration roadmap, zero synthetic identifiers); issue #4304 (`__q{N}`
  catalogue entry this ADR answers); issue #1998 (the `__qN` collision-avoidance
  loop this proposal retires as dead code)

> **Numbering note.** This was originally drafted as ADR-0184, picked before
> checking that #4291 (ADR-0184, definition-side `@UnscopedRef`) had already
> claimed that number on `main`. Renumbered to 0185 on the same pass that
> corrected the anonymous-types error below; no content implication.

## Context

`cs2gs` lowers a C# query expression (`from x in xs let y = f(x) where g(x,
y) select h(x, y)`) to the equivalent `System.Linq` method chain
(`.Select(...).Where(...).Select(...)`, per ADR-0115 §B), because G# has no
native query-comprehension syntax. This mirrors the C# language spec's own
query-expression translation (§12.19.3) almost exactly — including the
spec's **transparent identifier**: whenever a clause (`let`, a second
`from`, or `join`) introduces a new range variable alongside ones already in
scope, C# bundles all of them into one compiler-synthesized anonymous-type
value (`new { x, y }`) so later clauses can still see every variable by
name.

`CSharpToGSharpTranslator.Types.cs`'s query lowering (`TranslateQuery` →
`LowerQueryBody` → `BuildScopeParameter`, `~2330`–`2819`) threads a widened
scope as a **positional tuple** instead of an anonymous object. Every lambda
cs2gs builds over a scope of more than one range variable
(`BuildScopeParameter`) needs a name for that tuple parameter. There is no
source name for it — it corresponds to no single variable the user wrote —
so cs2gs synthesizes one: `__q{N}`, then immediately destructures it back
into the real range-variable names via a `let (x, y, …) = __qN` prologue
statement, so the lambda BODY only ever sees real names again.

**Correction to an earlier draft of this ADR:** that draft asserted "G# has
no anonymous types" as the reason a tuple is used here, citing
`BuildScopeParameter`'s own comment (`CSharpToGSharpTranslator.Types.cs:2765`,
also `DocumentTranslationState.cs:256`), which attributes that claim to issue
#1902. This is false today, and a reviewer caught it: G# has had anonymous
object literals since ADR-0146 (`object { let a = 123; let b = "hi" }`),
and ADR-0146 explicitly supersedes tuple lowering for anonymous objects
(its own Related line). The claim was true when the comment was written —
issue #1902 (created 2026-07-03) is the work that introduced the `__qN`
scheme — and became false four days later when ADR-0146's implementing
issues (#2224, #2243, created 2026-07-07) shipped anonymous objects; nobody
revisited the query-lowering carrier choice afterward, and this ADR's first
draft trusted the stale comment instead of checking the current language.
**Why the recommendation below is unchanged despite the correction:** see
Alternative 3, which evaluates the anonymous-object carrier on its own
merits (not on the false "doesn't exist" premise) and rejects it for a
different, correct reason — it does not actually eliminate the naming
problem, and it is the structurally worse carrier for this specific use
even if it did.

This is issue #4304's catalogue entry. It is the single largest ACTIVE
synthetic-identifier family in the self-migration corpus (23 code / 55 raw
occurrences on the CI run 35287979111 tree) — ahead of every other live
family, including the second-largest, `__generatedRegex_` (7).

### Every clause shape reaches the same one function

`BuildScopeParameter` is the ONLY place `__qN` is synthesized, and every
multi-variable-scope clause shape routes through it, directly or via
`BuildScopeLambda`/`BuildTransparentResultSelector`:

| C# clause | G# operator(s) | Lambda(s) built over the (possibly widened) LEFT scope |
|---|---|---|
| `where` | `Where` | predicate (`QueryCall` → `BuildScopeLambda`) |
| `orderby`/`orderby ... descending`, chained | `OrderBy`/`OrderByDescending`/`ThenBy`/`ThenByDescending` | key selector, once per ordering |
| `let x = e` | `Select` (widens scope by 1) | projection returning the widened tuple |
| second `from x in e` | `SelectMany` (widens scope by 1) | collection selector (current scope) AND result selector (current scope, left param) |
| `join x in e on k1 equals k2 [into g]` | `Join`/`GroupJoin` (widens scope by 1) | outer key selector (current scope) AND result/group-result selector (current scope, left param) |
| final `select e` | `Select` (narrows to the projected shape; elided when it is the identity) | projection |
| `group e by k` | `GroupBy` | key selector, and (unless identity) element selector |
| `into y` continuation | (none directly — restarts the scope as a single variable and recurses) | — |

Every row above except the continuation itself needs a lambda parameter
over the CURRENT scope, and every one of those goes through
`BuildScopeParameter`. This matters for the design: **there is exactly one
emission site, shared uniformly across every clause kind**, so a fix at
that one site retires the family everywhere at once — no per-clause
special-casing is needed, and (see below) no change to evaluation order,
laziness, or which `System.Linq` operator gets called is needed either.

### C# query semantics this design must not disturb

**Correction to an earlier draft:** a reviewer's automated check (GitHub
Copilot) caught that an earlier version of this section conflated two
distinct properties of Standard Query Operators — fixed below.

Two properties matter here and must be kept separate:

- **Selector invocation frequency** is per-element for every operator's
  delegate arguments, with no exceptions: `Where`'s predicate, `Select`'s
  projection, `SelectMany`'s collection selector, `OrderBy`/`ThenBy`'s key
  selector, and `GroupBy`'s key/element selectors each run once per SOURCE
  element. `Join`'s outer/inner key selectors run once per outer/inner
  element respectively, and its result selector runs once per MATCHED PAIR
  (zero times for an outer element with no match, more than once for one
  with several). `GroupJoin`'s outer key selector runs once per outer
  element, and its result selector also runs once per outer element —
  pairing each with its whole matched inner group in one call. None of
  these invoke a selector "once total" or "once per enumeration."
- **Buffering** is a separate, coarser property, about how much of a
  SEQUENCE an operator must consume before it can produce any output, not
  about selector call counts: `OrderBy`/`ThenBy` and `GroupBy` must consume
  their entire SOURCE sequence up front (sorting/grouping needs to see
  everything before yielding the first result); `Join`/`GroupJoin` buffer
  only the INNER sequence into a lookup, while the OUTER sequence still
  streams one element at a time; `Where`/`Select`/`SelectMany` buffer
  nothing at all.

Any design here must preserve exactly which operator is called, in exactly
what order, with exactly the same argument count, the same per-element
selector invocation frequency, and the same buffering behavior — this ADR
does not touch any of that. It only changes how one already-existing
tuple-typed **parameter** is spelled.

## Decision (proposed)

**Add parameter-position tuple destructuring to G# lambda/arrow parameter
lists**, extending the existing statement-position mechanism (`let (a, b)
= e` / `var (a, b) = e`, ADR-0032/ADR-0168) into that parameter list:

**Correction to an earlier draft:** the code example below originally
showed the `func (params) RetType { ... }` function-literal form. That was
wrong — verified against `BuildScopeLambda`/`BuildTransparentResultSelector`
(`CSharpToGSharpTranslator.Types.cs:2699`,`:2738`), neither of which ever
constructs a `LambdaExpression` with `isFunctionLiteral: true`, and against
`GSharpPrinter.RenderLambda` (`~line 1092`), which renders a block body as
`func (...) { ... }` only when that flag is set, and as arrow form
`(...) -> { ... }` otherwise (the default). Query-scope lambdas render as
arrow lambdas, always. Tracing `BuildScopeLambda`'s own branching (a
`TupleDeconstructionStatement` prologue is added whenever `scope.Count > 1`,
forcing the block-body branch) gives the REAL current output for `where
g(x, y)` over scope `{x, y}`:

```gs
// today, synthesized (arrow-lambda form):
(__q0 (string, int)) -> {
    let (x, y) = __q0
    return g(x, y)
}

// proposed — and note the whole lambda collapses back to an
// expression body, because BuildScopeParameter no longer needs to add
// ANY prologue statement once the parameter destructures itself:
((x string, y int)) -> g(x, y)
```

Concretely:

1. **Parser — the arrow-lambda parameter path, which is where this is
   actually needed.** `LooksLikeLambdaStart` and `ParseLambdaParameter`
   (both `src/Core/CodeAnalysis/Syntax/Parser.Expressions.Lambdas.cs:61`
   and `:365`) are a fully independent parsing path from
   `Parser.Members.cs`'s `ParseParameter` — confirmed by inspection,
   `ParseLambdaParameter` never calls `ParseParameter`; it duplicates the
   annotation/`scoped`/`ref`-`out`-`in`/identifier/ellipsis/type/default
   logic itself, with its own `MatchToken(SyntaxKind.IdentifierToken)` for
   the name. And since query-scope lambdas always render in arrow form
   (never as a `func (...) { ... }` function literal, see above),
   `Parser.Members.cs`'s `ParseParameter` is **not on the critical path**
   for retiring `__q` at all — an earlier draft of this ADR targeted the
   wrong function. Two changes are needed, both in
   `Parser.Expressions.Lambdas.cs`:
   - `LooksLikeLambdaStart`'s non-empty-parameter-list check (`~line 197`:
     `if (Peek(j).Kind != SyntaxKind.IdentifierToken) { return false; }`)
     is the LOOKAHEAD DISAMBIGUATOR deciding whether a `(...)` followed by
     `->` is a lambda at all, before any parameter is actually parsed. Its
     own comment says anything other than a leading identifier — including
     another `(` — is today treated as a parenthesized expression instead.
     A destructured parameter's first token is `(`, so a query lambda with
     one would not even be recognized as a lambda start; it would misparse
     as a parenthesized tuple expression. This check needs to also accept
     `(` as a legal opener and then apply a bounded trial-parse of the
     interior as a destructuring pattern before committing — matching this
     same function's existing style for a case it already can't resolve by
     a cheap token check alone (see the `unsafeDepth > 0` trial-parse block
     later in the same function: speculatively parse, and roll back
     position/diagnostics if it doesn't cleanly commit to the closing `)`
     already located).
   - `ParseLambdaParameter` itself then needs the same destructured-name
     production described below, independently of `ParseParameter`, since
     the two functions don't share that code today.
2. **Scope: `Parser.Members.cs`'s `ParseParameter`/`ParseParameterList` are
   explicitly OUT OF SCOPE for this fix.** That shared production feeds
   ordinary named functions/methods, primary constructors, indexers,
   receiver clauses (`~line 1264`), `init` declarations (`~line 83`), and
   event payloads — none of whose binders expect anything but a single
   `ParameterSyntax.Identifier` today (caught by the same reviewer pass:
   an earlier draft's Decision section proposed changing this shared
   function directly, which would have silently exposed the new syntax on
   every one of those surfaces at once, with no binder ready for any of
   them). `__q`'s own fix never needs this function touched at all, since
   its emission is arrow-lambda-only (point 1). Extending destructured
   parameters to ordinary named functions (and, by extension, to every
   other surface `ParseParameter` feeds) may be worth doing later for
   hand-written-G# ergonomics, but it is a separate decision that needs its
   own audit of every one of those binders — deliberately not bundled into
   this fix, whose only requirement is the arrow-lambda path in point 1.
3. **Binder**: bind each destructured name as an ordinary parameter-scoped
   local of its element type, reusing the existing tuple-deconstruction
   binding machinery ADR-0032/0168 already built for `let (a, b) = e`
   (`TupleDeconstructionStatement`'s binder) rather than inventing a second
   one. The parameter LIST's overall type is still the tuple type — this is
   purely a binding-time convenience, not a change to the function's
   signature/metadata.
4. **Emit**: at method entry, unpack the incoming tuple argument into the
   destructured locals — mechanically the same unpacking the statement-form
   deconstruction already emits for a tuple RHS, just at parameter-bind time
   instead of after a `let`.
5. **cs2gs**: change `BuildScopeParameter` to emit a destructured parameter
   (`(x Type1, y Type2, …)`) instead of a synthetic name plus a
   `TupleDeconstructionStatement` prologue, whenever `scope.Count > 1`. No
   other change to `TranslateQuery`/`LowerQueryBody`/`LowerLetClause`/
   `LowerAdditionalFromClause`/`LowerJoinClause`/`LowerGroupClause`/
   `QueryCall`/`BuildScopeLambda`/`BuildTransparentResultSelector` is
   needed — they all just stop receiving a prologue-deconstruction
   statement from `BuildScopeParameter` and start receiving a
   directly-usable parameter.

Because cs2gs already computes each scope entry's `GTypeReference`
(`scope[i].Type`) before calling `BuildScopeParameter`, the emitted
destructured parameter can always be fully, explicitly typed — this
proposal does NOT require gsc to be able to INFER per-element types of a
destructured lambda parameter from context (e.g. from a generic method's
substituted type argument). That inference question may be worth its own
follow-up for hand-written G# ergonomics, but it is not on the critical path
for retiring `__q`.

### Coverage: this retires `__q` for every clause shape, completely

Because every clause in the table above funnels through the one
`BuildScopeParameter` call site, and this proposal changes only what THAT
function emits (not which operator is called or in what order), it
resolves `where`, `orderby`/`thenby` (any number, ascending or descending),
`let`, additional `from`, `join`/`join … into`, the final `select`
(including the elided identity case), `group by` (including the elided
identity case), and `into` continuations uniformly — all of them, not a
subset. This is unlike a lowering-strategy change (see Alternative 1,
below), which would need separate treatment per operator and would not
even solve the naming problem where it does apply.

### Side effect: issue #1998's collision loop becomes dead code

`BuildScopeParameter`'s collision-avoidance loop (bumping `__qN` past a
collision with an in-scope range variable or a visible outer local,
`IsNameVisibleAtCurrentQuery`) exists ONLY because `__qN` is a synthetic
name sharing a scope with real ones. Once the destructured parameter uses
the REAL range-variable names directly, a same-name collision between a
query range variable and an outer local becomes an ordinary identifier
collision — exactly the kind `EmittedNameAllocator`/`SanitizeIdentifier`
already resolves everywhere else in this translator (append `_`, retry).
Issue #1998's bespoke loop, and the `state.QueryScopeCounter` field it
loops with, can be deleted once this lands, rather than kept as a second
collision-handling code path.

The arity cap diagnostic (`scope.Count > 7`, no canonical G# tuple —
`ADR-0115 §B`) is unaffected either way and should stay exactly as it is;
this proposal changes how a scope's tuple parameter is SPELLED, not how
wide a scope G# tuples can represent.

## Alternatives considered

### 1. Restructure the per-clause chain into fewer, nested calls — rejected

One tempting-looking direction: instead of mirroring the C# spec's
clause-by-clause `.Select`/`.Where` chaining 1:1, lower a widening clause
and everything after it into ONE outer call, nesting the later clauses as
native G# statements (`let`, `if`, `return`) inside a single lambda body,
so `x`/`y` stay ordinary same-scope closures the whole way through and
never get bundled into a carrier at all.

This does not work, and not for a shallow reason: **`SelectMany`, `Join`,
and `GroupJoin` require multiple, separately-parameterized lambda
arguments by their OWN signatures** — `SelectMany`'s
`Func<TSource,IEnumerable<TCollection>> collectionSelector` and
`Func<TSource,TCollection,TResult> resultSelector` are two different
delegates with two different arities, not an artifact of how Roslyn happens
to desugar query syntax. There is no way to "nest" a result-selector's
per-pair logic inside the collection-selector's per-source-element logic —
they run at different times over different sequences (the collection
selector runs once per outer element to produce an inner sequence;
`SelectMany` then flattens and pairs; the result selector runs once per
flattened pair). The same holds for `Join`/`GroupJoin`'s four arguments.

Even restricted to the NON-widening operators where it might seem to apply
(`Where`, `OrderBy`/`ThenBy`, the final `Select`, `GroupBy`) — these are
**sequence-level** operators: `Where` filters a whole sequence, it cannot
be nested as a statement inside a single per-element function body,
because "nested inside one lambda" would only run per element, with no
sequence-level view to filter over. So this direction does not eliminate
the need for a name on the multi-variable scope parameter even where it
superficially seems to apply — it only moves WHERE that parameter appears,
never solving the actual naming problem. Withdrawn.

### 2. Native G# query-comprehension syntax — rejected

G# could grow its own `from`/`where`/`select` comprehension syntax, sidestepping
the transparent-identifier problem by letting the compiler bind each range
variable as an ordinary lexically-scoped name the way a native `for`
loop's iteration variable already is, with no tuple carrier ever
constructed at the SOURCE level.

Rejected as disproportionate: G# is a deliberately Go-flavored language
that has never had query-comprehension syntax, and the underlying
method-chain lowering this ADR is scoped around is already semantically
correct — the ONLY problem it has is one parameter's name. Adding a whole
new surface-syntax feature to solve a naming problem is not a proportionate
response, especially since such a feature would *still* need SOME answer
for how its own desugaring binds multiple range variables through a
projection boundary internally — i.e. it would likely still want tuple-
destructuring parameters (Direction taken above) as a building block, so it
does not even obviate this ADR's proposal. Withdrawn; revisit only if a
much broader case for native query syntax emerges independent of `__q`.

### 3. Use an ADR-0146 anonymous object as the scope carrier instead of a tuple — rejected

The direction a reviewer's correction (above) raised: since G# does have
anonymous objects, have `BuildScopeParameter` build `object { let x = ...;
let y = ... }` instead of a tuple, using the real range-variable names as
the object's own property names, and see whether that alone avoids needing
a synthesized parameter name.

**It does not, on its own.** Swapping the carrier's TYPE from a tuple to an
anonymous object does not change that the LAMBDA PARAMETER binding to that
value still needs some name — whatever the parameter's type is, it is one
value with one binding site. The `__qN` problem is a parameter-naming
problem, not a carrier-type problem, so this direction only helps if G#
also has some way to DESTRUCTURE an anonymous-object-typed value directly
at parameter position (a property-pattern parameter, `func ({x, y}) bool
{ ... }`), the same shape of grammar gap this ADR already found for tuples.

Checked directly rather than assumed: G# does have property patterns
(`PropertyPatternSyntax`, `BoundPropertyPattern`, `PatternBinder.cs`), but
they are parsed by `Parser.Patterns.cs` and bound only in `is`-expression
and `switch`-pattern contexts — a structurally separate grammar production
from `Parser.Members.cs`'s `ParseParameter`, which (per the Decision above)
accepts only a single identifier today. Neither tuple destructuring nor
property-pattern destructuring is available at parameter position today;
adding either is equal-sized new grammar work, not a shortcut.

Given that, which carrier is the better one to build that new grammar
around? Tuples, for reasons independent of whether anonymous objects exist:

- ADR-0146's field-only anonymous objects are synthesized and CACHED as
  real `StructSymbol`s (get-only auto-properties, private backing fields)
  via `AnonymousTypeCache`, keyed by the ordered `(name, type-identity)`
  shape — a genuine CLR type gets created per distinct scope shape a query
  happens to produce. A `TupleTypeReference` (the BCL `ValueTuple` family,
  ADR-0115 §B) is a lighter positional bundle with no property-accessor
  ceremony and no type-synthesis/caching step.
- The query-scope carrier is purely internal and mechanical: it exists for
  exactly one statement (or is immediately available as a destructured
  parameter, under this ADR's proposal) and is never referenced by name
  again, never returned, never inspected by a consumer. ADR-0146's
  anonymous objects are designed for the opposite case — a value a *user*
  constructs, potentially returns, and reads members off of by name later.
  Paying for struct-type synthesis and property accessors to immediately
  discard the result is strictly worse than a positional tuple here, with
  no compensating benefit.
- Property-pattern grammar also carries pattern-MATCHING semantics (literal
  sub-patterns, type tests, nested patterns, discards) that this use case
  does not need at all — every scope element is unconditionally bound, none
  of them are being tested against anything. Reusing pattern grammar for a
  pure capture-only binding is a semantic mismatch; tuple destructuring
  (ADR-0032/0168) is already exactly "unconditional structural binding,"
  the shape actually needed here.

Withdrawn. The recommendation is unchanged by this alternative, but for the
right reason: not because G# lacks anonymous types (it doesn't), but
because they are the wrong tool for an ephemeral, translator-internal,
arity-bounded carrier that tuples already serve well.

## Impact

- Retires 100% of the `__q` family (23 code / 55 raw occurrences on the
  reference tree) — cs2gs's translated output stops synthesizing this
  name entirely, for every query clause shape.
- Deletes `state.QueryScopeCounter` and the `IsNameVisibleAtCurrentQuery`
  collision loop in `BuildScopeParameter` (issue #1998's mechanism becomes
  unreachable dead code, safe to remove in the same change).
- No change to evaluation order, laziness, operator selection, or argument
  count for any query clause — this is a pure parameter-spelling change.
- Adds one new syntax form to G#'s arrow-lambda parameter grammar
  (`LooksLikeLambdaStart`/`ParseLambdaParameter`), usable by hand-written G#
  arrow lambdas as well as translator output — a genuine language feature,
  not a translator-only escape hatch, matching this repo's general
  preference for retiring synthetic families via native spellings (Track A
  of #3501) rather than smarter-but-still-synthetic translator tricks.
  Deliberately does NOT touch `Parser.Members.cs`'s shared `ParseParameter`
  (see Decision point 2), so ordinary named functions, primary
  constructors, indexers, receiver clauses, `init` declarations, and event
  payloads are unaffected — extending destructuring to any of those is a
  separate future decision, not a consequence of this one.

## Open questions for the implementer / reviewer

1. This proposal's binder/emit steps (3)/(4) above ASSUME the existing
   statement-position tuple-deconstruction machinery (ADR-0032/0168) is
   cleanly reusable at parameter-bind time. That reuse is not verified
   against the actual binder/emit code in this pass — someone implementing
   this should confirm `TupleDeconstructionStatement`'s binder and codegen
   can be invoked (or refactored into a shared helper) at a function's
   entry point, not only after a `let`/`var` statement, before committing
   to the exact grammar shape below.
2. Grammar shape: this ADR writes `(x string, y int)` (each destructured
   name immediately followed by its own type, matching a parameter list's
   existing `name Type` shape) rather than `((x, y) (string, int))`
   (names grouped, then one tuple type) — the former reads better and
   avoids a second parenthesized group, but should be checked against
   the rest of G#'s grammar for ambiguity (e.g. distinguishing this from a
   parenthesized SINGLE parameter with a tuple TYPE, `(pair (string,
   int))`, which is already legal and must keep meaning "one parameter
   named `pair` of tuple type," not silently change meaning).
3. Should destructured parameters support NESTED patterns (a tuple element
   that is itself a discard, or itself a nested tuple)? `__q`'s own usage
   never needs this — every scope element is a plain named range variable
   — so it is out of scope for retiring `__q` specifically, but worth a
   decision either way before shipping the grammar, since `__decon`'s
   catalogue entry (issue #4300) touches a structurally similar nested-
   pattern question and the two features may want to share a grammar
   rule.
4. ~~Whether ordinary (non-lambda) function declarations should ALSO accept
   destructured parameters~~ — resolved by Decision point 2, added in the
   same pass that fixed this ADR's original `ParseParameter`-vs-arrow-lambda
   mixup: `__q`'s fix only touches the arrow-lambda parameter path
   (`ParseLambdaParameter`/`LooksLikeLambdaStart`), and `ParseParameter`
   (the production ordinary functions and every other listed surface
   shares) is explicitly left untouched. Extending destructuring there is
   real future work, but it is now a separate decision with its own
   blast-radius audit, not an open question this ADR needs to answer to
   ship.
5. `BuildScopeParameter`'s own comment (`CSharpToGSharpTranslator.Types.cs:2765`)
   and `DocumentTranslationState.cs:256` still cite issue #1902 for "G# has
   no anonymous types" — stale since ADR-0146 shipped (see Context's
   correction above). Whoever implements this ADR should fix those two
   comments in the same change, independent of which carrier they end up
   describing, so the next reader doesn't inherit the same false premise.

## Recommendation

Adopt the destructured-parameter direction. It is the only one of the
three directions considered that actually removes the need for a
synthesized name (rather than just relocating it or, in Alternative 3's
case, not removing it at all), it covers every clause shape uniformly
through the query lowering's single shared emission site, it carries zero
risk to query evaluation semantics because it changes nothing about which
operators are called or when, and it retires issue #1998's
collision-avoidance code as a beneficial side effect. The three rejected
directions are recorded above so a future reviewer does not have to
re-derive why they do not work.
