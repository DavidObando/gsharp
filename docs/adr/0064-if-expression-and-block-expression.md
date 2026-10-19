# ADR-0064: If-expression and block-with-trailing-expression value forms

- **Status**: Accepted
- **Date**: 2026-06-10
- **Implemented**: 2026-06-10 (PR [#680](https://github.com/DavidObando/gsharp/pull/680), issue [#669](https://github.com/DavidObando/gsharp/issues/669))
- **Finalized**: 2026-06-11 (issue [#711](https://github.com/DavidObando/gsharp/issues/711))
- **Amended**: 2026-10-17 (issue [#4962](https://github.com/DavidObando/gsharp/issues/4962)): the if-expression accepts the if-statement's `SimpleStmt ';'` header initializer, with the same scoping. See the addendum at the end.
- **Phase**: Phase 8 — language ergonomics / expression surface
- **Related**: ADR-0062 (generalized ternary), ADR-0009 (switch semantics), ADR-0069 (smart casts), issues #669, #706, #711, #3355, #4964
- **Amended by**: [ADR-0202](0202-one-rule-for-block-tails-and-arrow-bodies.md) (2026-10-17): a block whose end is unreachable has the `never` type instead of reporting GS0277; a switch expression can be a block's trailing value; the `throw` addendum below is superseded
- **Amended**: 2026-10-17 (issue [#4964](https://github.com/DavidObando/gsharp/issues/4964)): the ternary narrows its branches exactly as the if-expression does

## Context

G# has a generalized ternary (`cond ? a : b`, ADR-0062) but no way to write multi-statement conditional expressions or readable `else if` chains in value position. Users coming from Rust, Kotlin, Swift, and F# expect `if` to work as a value-producing expression.

## Decision

Add `if` as a value-producing expression that coexists with the ternary:

```ebnf
IfExpression := 'if' (SimpleStmt ';')? Expression Block ('else' (IfExpression | Block))?
Block        := '{' Statement* (Expression)? '}'
```

(The `(SimpleStmt ';')?` initializer was added by the issue #4962 addendum
below. The original decision had no initializer.)

- The block's final expression (last expression statement) is the value.
- `if` without `else` is statement-only; using it in value position reports **GS0276**.
- A block without a trailing expression in value position reports **GS0277**.
- `else if` chains are right-associative (nested `IfExpressionSyntax`).
- Common-type/branch-type-unification rules are identical to ADR-0062 ternary.
- Lowers to the same `BoundConditionalExpression` that ternary uses (no new emit logic).
- Multi-statement blocks lower to `BoundBlockExpression` (already exists for interpolated strings and object initializers).

## Examples

```gsharp
let f = if filter != nil { filter!! } else { LibraryFilter() }

let title = if user.IsAdmin {
    log("admin route")
    "Admin Dashboard"
} else {
    "Home"
}

let grade = if pct >= 90 { "A" }
           else if pct >= 80 { "B" }
           else { "C" }
```

## Diagnostics

- **GS0276**: if-expression in value position must have an `else` branch.
- **GS0277**: block in if-expression value position must end with a value-producing expression.

## Consequences

- **Positive**: multi-statement branches and `else if` chains now work in value position.
- **Positive**: no new bound-node kinds; reuses existing `BoundConditionalExpression` and `BoundBlockExpression`.
- **Neutral**: ternary (`?:`) continues to work unchanged (coexistence).
- **Negative**: `if` at expression-level requires the parser to disambiguate struct-literal syntax (`name { }`) from block expressions; resolved via `suppressTrailingObjectInitializer`.

## Addendum (issue #711, 2026-06-11)

Issue #711 finalises ADR-0064. The following points were left implicit in the
original ADR and are now pinned down:

- **Branch-tail value form.** The trailing expression of a block is the last
  *expression statement* of the block, lifted out and used as the block's
  value. There is no `yield` keyword on this path; ADR-0064 is the
  expression-position counterpart to the existing switch-expression form, and
  switch-expression arms also have no `yield`. (G#'s `yield` is reserved for
  iterator state-machine bodies — see ADR-0030.)
- **Statement-form preservation.** Existing `if` statements MUST still parse
  and behave unchanged. The parser disambiguates by call-site: the primary
  expression slot tries an if-expression parse first; `ParseIfStatement` is
  only reached from `ParseStatement`. An if-expression in expression position
  requires an exhaustive `else` chain (GS0276); an if used as a statement may
  omit `else`.
- **Common-type rule.** The result type is the common type of all branch
  tails, computed by the same `ComputeConditionalCommonType` helper that
  ADR-0062 uses for the ternary. Branch tails are then implicitly converted
  to that result type. Mismatched branch types report GS0263 (the same code
  the ternary uses), so users see one consistent diagnostic.
- **Interaction with the switch expression.** A switch-expression arm and an
  if-expression branch follow the *same* common-type rule, so the two forms
  compose cleanly: a `switch { ... }` value may be the trailing expression of
  a block, and an `if … else if … else …` chain may sit in an arm body.
- **`throw` in a branch tail.** *Superseded by ADR-0202.* This bullet
  predates throw expressions (ADR-0121), which made both of its claims false:
  `throw` is also an expression, and switch-expression arms accept it. A branch
  may now simply end in `throw` (or `return`, `break`, `continue`): a block whose
  end is unreachable has the bottom type `never` and unifies with the other
  branch, so the old workaround of a dead tail value is no longer needed.
- **Reference-vs-value branch types.** Branch tails of different types share
  the common-type rule above; a value type and a reference type unify only
  when one is implicitly convertible to the other (e.g. `T` to `object`).
  Without a common type the binder reports GS0263.
- **Flow narrowing (ADR-0069) and `if let` (ADR-0071).** The expression-form
  if-expression does not introduce a new narrowing or binding shape — it
  reuses the existing `IfExpressionSyntax`/`BlockExpressionSyntax` plumbing
  that was already wired through the binder, so smart-cast narrowing of
  variables tested in the condition still applies inside both branches.
  `if let` and `guard let` remain *statement* forms (ADR-0071) when they lead
  a statement, and continue to parse via `ParseIfLetStatement` /
  `ParseGuardLetStatement`. **Addendum (ADR-0151):** `if let` additionally has
  a value-producing EXPRESSION form,
  `if let a = e [, let b = e2]* [&& guard] { … } else { … }`, parsed as a
  distinct `IfLetExpressionSyntax` in value positions only. It reuses this
  ADR's block-tail, terminal-`else`, common-type, target-typing, and
  GS0276/GS0277/GS0263 rules verbatim, and lowers into the very same
  `BoundConditionalExpression` / `BoundBlockExpression` pair — so the
  expression form does not subsume `guard let`, and this ADR's statement/
  expression split is unchanged for plain `if`.
- **Block-as-expression rules.** A `{ stmt*; tailExpr }` block in value
  position requires a non-empty tail (GS0277), unless its end is unreachable
  (ADR-0202: it then has the `never` type) or its value is discarded (ADR-0202:
  it is then a void block). A block with only statements
  is still legal in *statement* position via `BlockStatementSyntax`; only the
  expression-position lifting needs a tail.
- **Coverage parity.** The compiler emit path and the interpreter both lower
  through `BoundConditionalExpression` / `BoundBlockExpression`, so no
  backend-specific work was required; tests cover both paths.

## Addendum (issue #3355): general block expressions

`BlockExpressionSyntax` is now a general primary expression rather than a form
reserved for `if` branches and arrow-lambda bodies:

```gsharp
let value = {
    let left = computeLeft()
    let right = computeRight()
    left + right
}

consume({ let item = next() item })
return 2 * { let item = next() item }
```

- The final expression is mandatory in expression position (`GS0277`); prefix
  statements execute in order, then the tail executes exactly once.
- The block owns a lexical scope. Locals can shadow outer names, remain visible
  to the tail and nested closures, and do not escape after `}`.
- Expected types flow into the tail in typed locals, assignments, returns,
  fields, collection elements, and call/constructor arguments.
- `return`, loop jumps, `yield`, exceptions, and `await` keep their enclosing
  control context. Lowering lifts suspension/control-flow-bearing blocks before
  emission so no path abandons a partially populated IL evaluation stack.
- Field/property initializers and `base(...)`/delegating-`init(...)` arguments
  are pre-body initialization contexts, so `return` is rejected there. A nested
  lambda still owns its normal function control context.
- An address-of block (`&{ statements; lvalue }`) executes its prefix before
  taking the tail lvalue's address; ordinary ref/out escape rules still apply.
- Statement blocks, object/collection literals, property patterns, lambda
  bodies, and switch/if statement bodies retain their contextual brace parsers.
- Statement-bearing blocks are not representable in CLR expression trees and
  report the existing precise `GS0473` unsupported-expression diagnostic.
- cs2gs uses this native form for expression-position spills, replacing the
  synthesized `__pN`/`__initN` helper path and its double-evaluation fallback.

## Addendum (issue #4962, 2026-10-17): the header initializer

The original decision gave the if-expression no initializer, and the spec
recorded that the statement's `if init; cond` form was "unchanged" by the
expression form. So `if var v = g(); v > 3 { … } else { … }` parsed as a
statement but failed to parse in value position (a spurious GS0276 followed
by GS0005 errors). The same `if` failed in one statement-shaped place too: a
trailing, else-terminated `if` in an arrow-lambda block body is the expression
form (ADR-0128, issue #2349), so `() -> { if var v = g(); v > 3 { … } else { … } }`
did not parse. Constructs that exist as both a statement and an expression
must behave the same, so the expression form now takes the statement's
header.

Revised rule:

```ebnf
IfStmt       := 'if' (SimpleStmt ';')? Expression Statement ('else' Statement)?
IfExpression := 'if' (SimpleStmt ';')? Expression Block ('else' (IfExpression | Block))?
```

- **One header routine.** Both forms parse `(SimpleStmt ';')? Expression`
  with the same parser routine (`ParseIfHeader`), so the two cannot drift.
  The initializer is detected the same way: a `;` at parenthesis and
  bracket depth zero before the then-block's `{` and before any nested `if`.
  An if-expression nested in the condition (`if if var x = f(); x > 0 { … } else { … } { … }`,
  or inside an index, `flags[if var i = 0; … ]`) keeps its own `;`. The initializer is one of the simple statements the
  statement form accepts: a `var` declaration, an assignment, an
  increment/decrement, or a call. The condition is parsed with the
  body-header rules in both forms (a bare `Name { }` is not read as a struct
  literal and a trailing object initializer is not absorbed).
- **Scope.** The initializer's declarations are visible in the condition, in
  the then-branch, in the else-branch, and in every link of an `else if`
  chain. They are not visible after the `if`. Each `else if` link may have its
  own initializer, visible in that link's condition and branches and in the
  links after it, and not in the earlier links. Redeclaring an outer name and
  reusing a name in a sibling `if` follow the rules for a nested block. This
  is what the statement form already did; the expression form now does the
  same.
- **Evaluation order.** The initializer runs exactly once, before the
  condition, each time the `if` is evaluated. Then exactly one branch runs.
  The initializer of an `else if` link runs only when that link is reached.
- **Lowering.** `if init; cond { a } else { b }` in value position lowers to
  `{ init; cond ? a : b }`, a `BoundBlockExpression` around the usual
  `BoundConditionalExpression`. The initializer is bound as a block
  expression's prefix statement, so the emitter, the async/iterator spiller
  and the closure analysis need no new cases, and an `await` in the
  initializer works under the normal async rules.
- **Target typing and branch rules are unchanged.** A contextual target type
  still flows into both branches, and a call argument still rebinds against
  its parameter type during overload resolution (issue #1238); the
  initializer's local is declared again in a fresh scope on each binding, so
  no GS0004 is reported.
- **Value-position differences that remain.** Only the ones that follow from
  value position: the expression form needs a terminal `else` (GS0276) and
  value-producing branch tails (GS0277). The initializer does not change
  either rule.
- **`if let` is a different header.** An `if` followed by `let` is the
  ADR-0071 / ADR-0151 binding form in both positions, so the initializer can
  never be a `let` declaration, and a `let` binding cannot follow an
  initializer (`if var v = g(); let w = v { … }`). Both forms reject these
  headers the same way. Use a `var` initializer, or put the binding in an
  inner `if let`.
- **Formatter.** gsfmt treats the header's `;` as a clause separator, like
  the `;` of a for-clause header, in both forms: the header stays on one
  line. gsfmt used to force a line break after the statement form's `;`
  (`if var v = g();` then `v > 3 {` on the next line); that output still
  parsed with the same meaning, and gsfmt now joins it back.

### Compatibility

The change only accepts code that failed to parse before. A valid
if-expression never has a `;` at parenthesis and bracket depth zero before
its then-block's `{` (a block-expression or lambda condition starts with or
contains its own braces first), so the initializer check is false for every
existing if-expression and it parses exactly as before. Counting brackets and
stopping at a nested `if` changes nothing for existing statements either: a
`;` inside brackets or after a nested `if` was never a valid initializer
separator. A search of the
repository's `.gs` sources, tests, samples, docs and cs2gs goldens found 0
if-expressions with an initializer. Two matches of the search pattern were
`;` characters inside string literals, which are single tokens. There are 7
statement-form uses, all in compiler test sources, and they are unchanged.
cs2gs neither emits nor reads this form: C# has no `if` initializer.

The condition of an if-expression is now parsed with the same body-header
helper as the statement's. The only difference from the old expression path
is that the helper turns off, inside the condition, the `for x in Name { }`
empty-struct-literal allowance of an enclosing `for … in` collection header.
That matters only for an if-expression written directly as a `for … in`
collection whose condition is itself `Name { }`, which no code in the
repository does. No migration path is needed.

## Addendum (ADR-0202, issues #4963, #4965, #4966)

- The *Interaction with the switch expression* bullet above is now implemented:
  a `switch` whose arms use `:` is the switch expression wherever a statement
  can start, so it can be a block's trailing value.
- GS0277 no longer fires for a block whose end is unreachable (it ends in
  `return`, `throw`, `rethrow`, `break`, `continue` or `goto`); the block has the
  `never` type. It no longer fires in a position whose value is discarded either.
- In such a discarded position an `if` without `else` is the void `if` (no
  GS0276), and an if-expression with a void branch is the void `if`.
- Every value-capable block — including arrow-lambda and arrow-member bodies —
  parses its last item by the same rule, so a final nested `{ … }` is the value
  everywhere. See ADR-0202 for the full rule and the compatibility measurement.

## Addendum (issue #4964, 2026-10-17): one narrowing rule for both conditional forms

The Finalized addendum says the if-expression keeps the smart-cast narrowing of
variables tested in its condition inside both branches. Issue #2640 implemented
that for the if-expression only. The ternary, which binds to the same
`BoundConditionalExpression`, bound its branches with pattern variables
(ADR-0166) but without narrowing, so `s != nil ? s.Length : 0` reported GS0158
while `if s != nil { s.Length } else { 0 }` compiled.

**Rule.** `c ? a : b` and `if c { a } else { b }` bind `a` under the narrowing
`c` implies when true and `b` under the narrowing it implies when false. One
helper, `ExpressionBinder.ClassifyConditionalNarrowing`, computes both frames
for both binders: a top-level nil guard (`x != nil`, `x == nil`, `nil != x`,
value-type nullables and ADR-0186 platform values included), merged with the
type-test and short-circuit frames (`x is T`, `x !is T`, `!`, `&&`, `||`).
Narrowing ends with the branch; nothing is lifted past the conditional in
either form. A narrowed value-type nullable read goes through
`ExpressionBinder.BuildNarrowedRead`, as in every other narrowing region.

The remaining syntax differences are structural: an if-expression's branches
are blocks, while a ternary's branches are single expressions. An if-expression
in a value-required position needs `else`; the discarded void forms can omit it
under ADR-0202.

**Compatibility.** A narrowed branch has its narrowed type, so a ternary
whose branch reads the guarded variable can now have a narrower result type,
exactly as the matching if-expression already had. With `n int32?`,
`n != nil ? n : 0` is now `int32` (it was `int32?`), which can change the
inferred type of a `let`/`var` and the overload chosen for an argument.

**`Nullable<T>` members on a narrowed value (issue #4986).** C# reads a
guarded value-type nullable through `Nullable<T>`'s own members, and
`n != nil ? n.Value : 0`, `n.HasValue` and `n.GetValueOrDefault()` compiled in
0.4.1270 and 0.5.7 because the ternary did not narrow. Narrowing alone would
have broken them, since `int32` has none of those members. The rule, for
every narrowing region (if-statement, if-expression, `?:`, early exit): a
member access on a variable or stable path narrowed from value-type
`Nullable<T>` to `T` binds against the original `Nullable<T>` storage when
`T` has no member of that name. A member `T` does have keeps binding to `T`
(a struct with its own `Value` field reads that field). The decision is made
in one place, `ExpressionBinder.BindAccessorStep`: the narrowed read that
`BuildNarrowedRead` builds is marked (`BoundUnaryExpression.IsNarrowingUnwrap`),
and when the accessed name is one `Nullable<T>` itself declares, a lookup that
binds nothing (`NarrowedTypeMayHaveMember`) asks whether `T` could have a
member of that name: its own instance or static members (including named
tuple elements), its interfaces or type-parameter constraints, or an
applicable source or imported extension.
Imported extension receivers use the CLR overload resolver's existing input
inference, constraint checks and implicit conversions, including generic
struct receivers and numeric widening. Unknown symbolic receivers and bounds
that supplied arguments can complete or widen remain conservative. Possible
bounds are recovered from the receiver, its hierarchy and implicit operators;
each closed possibility is checked by the method constraint checker and the
ordinary conversion classifier against its closed imported receiver parameter. Only bounds
mentioned by supplied argument slots may change. This preserves fixed generic
arguments and variance, and lets structural conversions such as tuple-element
widening use the inferred substitutions rather than an open CLR signature.
An incomplete receiver bound is not evidence of impossibility: supplied
arguments can close a generic conversion target, or refine a contravariant
upper bound to a subtype that is not enumerable from the receiver. The probe
validates partial bounds symbolically and retains compatible unknown subtypes,
checking every independent constraint without enumerating arbitrary completions.
Sealed or disjoint class bounds and invariant receiver positions cannot use
that escape hatch. A target-declared
conversion with an input independent of its type parameter can leave that
parameter free for later arguments, including value-type/interface or enum
constraints for which no representative type is available. Unknown subtype
bounds retain their dependent obligations: known arguments are substituted
before testing upper bounds, and fixed arguments that constrain an unknown
bound from below or above are checked rather than erased with the open
parameter. Operator input bounds are substituted first; freedom is tracked
per output parameter, so an input that fixes `U` does not also fix unrelated
`T`. Fixed input bounds keep their constraint checks.
Constraints crossing fixed and free parameters are substituted and retained,
not rejected wholesale. A closed contravariant receiver bound can still be
refined by later arguments: only fixed or explicitly pinned arguments impose
dependent lower/upper obligations on another parameter. Provisional bounds
may refine together, retaining their original receiver bounds.
Open class constraints retain their relationship to those bounds: disjoint
class hierarchies cannot refine together, and matching constructed class
bases contribute exact invariant arguments. Those arguments are pinned only
after checking their original receiver bounds, so joint refinement does not
erase an incompatible dependent bound.
Invariant argument shapes are compared recursively; an unresolved leaf does
not make a mismatching enclosing generic or array shape possible. A
type-parameter upper bound also contributes its inherited constraints,
transitively, so reopening `T : U` does not discard `U`'s class bounds.
Open arguments must pass this symbolic validation even when the ordinary
constraint checker defers them without reporting a failure. Receiver-shape
checks recursively reject impossible standard conversions and implicit-operator
inputs, including fixed invariant arguments. Ordinary receiver paths do not
discard an operator's input bounds and retry an unrelated completion.
Missing bounds never trigger Cartesian receiver completion. A fixed argument's
open generic constraint must have a compatible actual interface or base shape;
ambiguous interfaces are retained as real alternative domains. Compatibility
requires joint support, not merely pairwise support: an odd cycle can satisfy
every pair without admitting any complete choice. Domains connected through
open parameters and their declared constraints are checked together;
independent components are never multiplied. Within a component, symbolic
validation propagates forced alternatives before branching on a smallest
remaining actual-interface domain, with rejected assignments memoized.
These choices are actual metadata alternatives, not invented receiver-type
completions, and each check retains the other conversion obligations.
Every parameter's lower/upper domain is checked for impossibility before any
recursive candidate pinning, including domains late in the parameter list.
The original receiver conversion supplies structural lower, upper and exact
bounds, not just contravariant upper bounds. This includes closed covariant
bounds and both the input and output of an implicit operator. Invariant bounds
remain exact even when the bound is an unsealed class. Reopening a provisional
argument never discards these conversion obligations.
Only an exact domain or invariant structural inference pins a candidate; finding a
single enumerated witness is not proof of uniqueness. Other viable domains
remain symbolic for later argument inference, not recursively multiplied
with the other parameters' domains. There is no recursive widening fallback.
Closed upper bounds are also candidate witnesses: reflected supertypes of a
lower bound do not enumerate covariance-derived common types such as
`IEnumerable<object>`. Exhausting those witnesses proves impossibility only
for a finite domain, not for an open reference-variance domain.
Variance contributes individual bounds even when repeated leaves cannot unify
to one type; reversing variance preserves which side contains an inferable
leaf. Each actual receiver-interface alternative keeps its own constraint
checks; a nonmatching carrier such as `object` cannot reopen an erased
receiver bound and bypass those alternatives. Unknown relationships remain
conservative for later argument inference.
Reference-variance refinement cannot introduce a value-type argument by
boxing. CLR sealing alone does not make a reference bound exact: variant
generic delegates can have narrower constructions.
Refinement follows the slot's variance direction; for example,
`Action<object>` can refine an upper bound of `Action<string>`, whereas
`Action<object>` itself has no stricter construction. Such sealed families
still retain their constructor and implemented-interface capabilities.
Bound promotion also recognizes genuine same-family CLR delegate return
covariance when the overload classifier ranks it separately from a reference
conversion; delegate shape adapters remain excluded.
The preliminary domain pass, symbolic validation and declared-bound check use
one effective-upper-bound compatibility query. Transitive interface bounds
remain in that query, so an indirect `IDisposable` obligation cannot be
discarded while refining a sealed delegate family. Incomparable constructions
are not disjoint nominal classes: `Action<object>` can refine both
`Action<string>` and `Action<Exception>`, and `Func<Both>` can refine
`Func<IFoo>` and `Func<IBar>` when `Both` implements both interfaces.
The query sends all bounds of a delegate family back through the same
symbolic solver as obligations on its generic slots, including their declared
constraints. It does not pin an arbitrary common construction or multiply
receiver completions. Value-only variance, different sealed families and
genuinely disjoint class bounds remain impossible.
Closed-family queries share a cache scoped to the enclosing member probe,
including recursive symbolic checks. Repeated passes therefore do not
multiply the same obligations in deeply nested variant constructions.
Reference lower bounds also propagate through open declared constraints.
For example, `IList<string> -> T -> IList<U>` contributes the invariant
`U = string` obligation to the same solver; a temporary shape-match dictionary
is not sufficient. Covariant and contravariant slots retain their respective
bound directions. Multiple actual interface constructions remain alternatives,
not conjunctive equalities or arbitrary receiver completions. Their domain
keys include the actual source and constraint; selecting an alternative can
reveal dependent actual domains, which must also have joint support.
Propagation follows finite parameter dependency paths rather than unfolding
recursive metadata indefinitely. Numeric and tuple promotions do not acquire
implemented-interface obligations from this reference-conversion rule.
Fixed identity/boxing lower bounds retain their provenance, including value
types: `V = Token` and `V : T : IView<U>` preserve the interfaces of `Token`.
Constraint conversion terms remain strict and contribute fixed bounds before
the receiver's promotable numeric/tuple bounds; a boxed struct is not discarded
merely because a different kind of value-type bound can widen.
Receiver-origin structs that have only standard identity/boxing conversions
preserve those interfaces too. Numeric lower bounds use a finite actual
promotion domain from the existing widening lattice and boxing carriers,
whether or not the parameter has a `struct` constraint. Value-only constraints
exclude reference carriers rather than enabling the propagation itself.
The same joint-domain validator checks each selected type's dependent
constraints; deferring an open interface obligation is not proof of support.
Selecting a numeric alternative contributes an exact bound while retaining the
original receiver conversion. Strict identity/boxing constraints retain boxing
but cannot become numeric promotions, and independent parameter domains remain
factored rather than forming a Cartesian receiver completion.
Inferring an element type cannot turn an `int32` receiver into a collection.
Object- and collection-initializer suffixes are transparent to this name lookup:
the original unbound head call still supplies the probe's argument shape.
Explicit generic
calls keep the narrowed binding (`Nullable<T>` declares no generic methods).
Only when none can is the member bound against the storage read. The member
and its arguments are bound once either way, so a member `T` declares keeps
its own overload diagnostics even when no overload applies, and an imported
extension of the same name that cannot take `T`
(`CollectionExtensions.GetValueOrDefault` on a dictionary) does not block the
fallback. An unknown shape answers "may have", which keeps the narrowed
binding. The read is an ordinary `Nullable<T>`
property or method access, so `n.Value` after a guard emits
`call Nullable<int32>::get_Value` on the storage, which the guard already
proved non-nil. The if-statement gains this too; it had rejected `n.Value`
after a guard in every release.

Same-compilation value types are included for `Value` and `HasValue`: their
`Nullable<T>` properties bind against the open `Nullable<>` and the emitter
parents the getter at the constructed `Nullable<T>`, guarded or not (they
reported GS0158 even unguarded before). This newly admitted path does not
bind method groups: their emitter does not yet construct the symbolic
`Nullable<T>` method reference, so accepting them would produce invalid IL.
`GetValueOrDefault` on a
same-compilation struct or enum still does not bind in any position (issue
#5001).

No diagnostic accompanies the fallback. A warning would break builds that
treat warnings as errors, an Info diagnostic is printed by `gsc` on every
build, and a Hidden one is dropped by both `gsc` and the language server, so
none of the available severities gives a fix hint (`write n`, `write true`)
without either breaking builds or reaching nobody.

Code that compiled cleanly in 0.4.1270 and 0.5.7 now warns or stops compiling in
these cases:

- **A `!!` the condition makes redundant (maintainer decision, kept).** A user
  `!!` on the narrowed variable in the proven branch
  (`s != nil ? s!!.Length : 0`) now reports the GS0536 redundant-assertion
  warning, exactly as in an if-statement or if-expression branch; `?:` does
  not suppress it. It stops the build only where warnings are errors.
  Migration: remove the `!!`.
- **The narrower type no longer fits.** A later `nil` assignment to an
  inferred local, or a call to overloads that differ only in reference
  nullability (`f(string)` / `f(string?)`), which are ambiguous for any
  non-null argument (issue #4971). Migration: state the type
  (`let r int32? = …`).
- **Expression-tree lambdas.** `(v int32?) -> v != nil ? v + 1 : 0` converted to
  `Expression[Func[int32?, int32]]` compiled, then threw `ArgumentException`
  when the tree was built (the body had type `Nullable<int32>`). It now reports
  GS0473, as the if-expression form already did, because the expression-tree
  lowerer does not yet lower a narrowed value-type read. Migration:
  `(v ?? -1) + 1`. A type-test narrowed read in an expression-tree lambda
  compiles and then throws at tree construction in every form (if-expression,
  `&&`, and now `?:`). Both gaps are issue #4974.

At the time of the change the repository held no nil-guard or type-test
ternary that reads its guarded variable in compiler, tool or sample source
(cs2gs lowers a C# `?:` to an if-expression, so its output was already
narrowed); the cases in test sources are listed in the PR.

**Known gap, shared by both forms.** A nil guard on a value-type nullable
under `!`, `&&` or `||` (`!(n == nil)`, `a != nil && b != nil` with `int32?`)
does not narrow in either form, because the short-circuit classifier accepts
reference nullables only. The if-statement does narrow these. That
statement/expression difference, and the if-statement's `[NotNullWhen]` call
narrowing, are tracked in issue #4969.

**Known gap, shared by every narrowing region.** An assignment inside the
narrowed expression does not end the narrowing for the rest of that
expression: `s != nil ? consume((s = nil), s.Length) : 0` compiles and
dereferences nil, as the if-expression, if-statement and `&&` forms already
did. Invalidation runs at statement granularity; issue #4985 tracks moving it
to the assignment.
