# ADR-0166: pattern variables in boolean `is` expressions

- **Status**: Accepted
- **Date**: 2026-08-16
- **Phase**: Language patterns / flow analysis / migration fidelity
- **Related**: ADR-0009 (switch patterns), ADR-0069 (smart-cast narrowing), ADR-0071 (`if let` / `guard let`), ADR-0115 (cs2gs), ADR-0162 (boolean `is` patterns), ADR-0163 (`while let`), [#3409](https://github.com/DavidObando/gsharp/issues/3409), [#3420](https://github.com/DavidObando/gsharp/issues/3420), [#3402](https://github.com/DavidObando/gsharp/issues/3402), parent [#3394](https://github.com/DavidObando/gsharp/issues/3394)

## Context

ADR-0162 wired the full pattern grammar into boolean `is`, but rejected every
source-visible binding there (GS0525) because "an expression has no coherent
region in which the name is definitely assigned". That decision left the
G# self-migration spike (#3394) unable to preserve the most common C# pattern
idiom. cs2gs lowered

```csharp
if (fa.Receiver is { Type: StructSymbol s } && s.IsClass)
{
    return false;
}
```

into a hoisted temporary, a repeated type test, and a null-forgiving cast:

```gs
{
    let __spill0 = fa.Receiver
    if __spill0 != nil &&
       __spill0.Type is StructSymbol &&
       (__spill0.Type as StructSymbol)!!.IsClass {
        return false
    }
}
```

The 231 `__spillN` temporaries in the translated Core tree were dominated by
this shape, and the hoisting itself was not always sound: a receiver read
could be evaluated before the null check that guarded it in the source
(`let __spill7 = receiver!!.Type` ahead of `receiver != nil && …`), which
changes short-circuit order and can throw. Issue #3402 documents the same
family of failures.

C# resolves the "no coherent region" concern with definite assignment: a
pattern variable is *definitely assigned when true* after `x is T t`, and the
compiler tracks that fact through `&&`, `||`, `!`, `?:`, `if`, loop
conditions, and the statements after an `if` whose other branch cannot
complete normally. G# already computes exactly those regions structurally for
smart-cast narrowing (`ClassifyTypeTestNarrowing`, `PendingEarlyExitFrames`,
`ApplyEarlyExitNarrowings`), so the infrastructure to scope a name to "where
the match is known to have happened" already existed.

## Decision

### Designation spelling

A pattern may name the value it matches by writing an identifier after the
pattern, C# style:

```gs
if value is string text && text.Length > 3 { ... }        // type pattern
if value is Dog { Name: "Rex" } dog { ... }                // type + property suffix
if value is { Length: > 0 } text { ... }                   // property pattern: non-nil, bind
if box is { Value: Dog d } && d.Name != "" { ... }         // nested designation
if value is { } present { ... }                            // empty property pattern: non-nil test
if values is [1, ..rest] && rest.Length > 0 { ... }        // slice capture
if value is var captured { ... }                           // total pattern: exact static type
if box is { Value: var item } { ... }                      // total nested subpattern
```

The designation is an identifier that directly follows the type clause (or
its property suffix, or the closing brace of a property pattern) on the same
source line and is not one of the contextual pattern words `and`, `or`,
`when`. `_` is a discard designation. A designation after a name-shaped
pattern commits the name to the type interpretation, just as a property
suffix does under ADR-0162.

`Type name` is accepted in every pattern position — boolean `is`, `switch`
statement cases, and `switch` expression arms — so one grammar covers all
sites. The pre-existing switch spelling `name is Type` remains valid in
switch positions. In boolean `is` position it stays rejected (GS0525, now
pointing at the designation spelling): `value is text is string` reads as an
incoherent double test.

The empty property pattern `{ }` is accepted over every input type as a pure
non-nil test (C# semantics); a non-empty member list still requires a struct,
class, interface, or tuple input.

`var name` is a total pattern: it never fails, includes `nil`, and binds the
input at its exact static type without narrowing. It is valid in every pattern
position, including property and list subpatterns. `var _` is a total discard.

### Semantics

A pattern variable is a read-only local (`let` semantics) whose type is the
tested type — the type-pattern target, the non-nullable input type for a
property pattern designation, or `[]T` for a slice capture. It is assigned
exactly once, when its pattern matches, and it is **in scope exactly where
C# would consider it definitely assigned**:

| Construct | Region that sees the when-true variables | Region that sees the when-false variables |
| --- | --- | --- |
| `A && B` | `B`; the whole expression is *when-true* for `A` ∪ `B` | intersection of both sides' when-false |
| `A \|\| B` | intersection of both sides' when-true | `B`; the whole expression is *when-false* for `A` ∪ `B` |
| `!A` | swaps the two sets | swaps the two sets |
| `if C { T } else { E }` | `T` | `E` |
| statements after `if C { T } [else { E }]` | when `E` always exits | when `T` always exits |
| `C ? X : Y`, `if C { X } else { Y }` (expression) | `X` | `Y` |
| `for C { body }` / `while C { body }` | `body` | — |
| `case P when G { body }` / `case P when G: result` | `body` / `result` for `G` | — |

"Always exits" is the existing `EndsInUnconditionalExit` structural rule
(`return`, `throw`, `break`, `continue`, `goto`, or an `if`/`switch` whose
every arm does). Only an `if` that is a direct statement of a block leaks its
variables into the following statements; an `else if` never does, because
the outer condition's other path reaches those statements without the match.

A read of a pattern variable outside its region reports **GS0532** ("not
definitely assigned here") rather than "variable doesn't exist". Two
variables with the same name that would be definitely assigned on the same
path (`a is T t && b is U t`, `{ A: T t, B: U t }`) report GS0102, the
C# CS0128 rule. A leaked variable that collides with a name already declared
in the enclosing block also reports GS0102 at the designation.

Pattern variables in `and` conjuncts follow the ADR-0162 narrowing rules;
bindings under `or` and `not` stay rejected (GS0390).

### Implementation shape

- The parser attaches an optional `Designation` token to `TypePatternSyntax`
  and `PropertyPatternSyntax`. Body-header brace speculation looks past a
  designation candidate when deciding whether `{ ... }` is a pattern or the
  statement body.
- `PatternBinder` binds a designation, including `var name`, to a `PatternVariableSymbol` (a
  read-only `LocalVariableSymbol`) without declaring it; a designated
  property pattern is bound as a type pattern over the stripped input type so
  emission reuses the type-pattern pipeline unchanged.
- `PatternVariables.Classify` computes the when-true / when-false sets over a
  bound condition; `ExpressionBinder` (`&&`, `||`, `?:`, if-expression),
  `StatementBinder` (`if`, loops, block-level leak via
  `PendingPatternVariableLeaks`), and the switch binders (guard → body)
  declare those sets in fresh child scopes for the matching regions. Any
  other variable a region declares (an inline `out var` in the right operand
  of `&&`) is hoisted back into the enclosing scope when the region closes,
  so expression variables keep their statement-level C# scope.
- `BoundIsExpression.IsSimpleTypeTest` is false for a binding type pattern,
  so the emitter takes the general pattern path that stores the value. That
  path now boxes a bare type-parameter source before `isinst` (and before the
  property pattern's nil check), the rule the simple type test already
  applied, so `value is IDisposable d` over `T` verifies.
- Closure lowering does not box a `PatternVariableSymbol`: it is written once
  before any region that can create a capturing lambda, so by-value capture is
  already correct.
- `DefiniteAssignmentAnalyzer` tracks conditional-goto edges separately
  (`ClassifyConditionAssignments`): an `out` argument in the right operand of
  `&&` is definitely assigned on the true edge only, and dually for `||`, so
  the native `x is T t && t.TryGet(out v)` shape reports no spurious GS0238.

### cs2gs

The translator prefers the native G# form whenever every designation in a
C# `is` pattern qualifies: the pattern is expressible in G# (declaration and
recursive property patterns, nested designations, constants, relational,
`and`/`or`/`not`, discards, and scalar `var` designations; no positional,
tuple, or whole-list designations), the variable is never reassigned, and every reference lies in a
region G# scopes it to (computed on the C# syntax with the table above). It
then emits `x is T t` / `x is { P: T t } u` verbatim, registers each binder
as an identity substitution, and produces no `__spillN`. Otherwise it falls
back to the previous `if let` / negated-guard / positive-guard / spill paths.

## Consequences

Positive:

- C# `is` patterns with designations translate one-to-one and keep their
  names; the dominant `__spillN` source and the unsound hoist ordering are
  gone.
- G# gains the C# idioms `if !(x is T t) { return }` followed by uses of `t`,
  and `x is T t && t.Member`, without new statement forms.
- One binder, one emitter, one flow classifier own pattern semantics for
  `switch` and `is` alike.

Negative:

- Pattern variables are `let`-immutable; C# code that reassigns a pattern
  variable keeps the cs2gs fallback.
- The scoping rule is structural rather than a full definite-assignment
  data-flow: `while (true) { if (x is T t) break; } use(t)` is valid C# but
  GS0532 in G#. cs2gs detects the difference and falls back.
- Two spellings coexist in switch positions (`name is Type` and
  `Type name`).

## Alternatives considered

- **Keep GS0525 and grow `if let`** — rejected: `if let` cannot express
  nested designations, `&&` continuation, or negated guards without hoisting,
  which is exactly the readability loss #3409 reports.
- **Full definite-assignment data flow in `DefiniteAssignmentAnalyzer`** —
  rejected for now: the analyzer runs post-lowering on a CFG whose branch
  edges do not carry per-edge state; the structural regions cover every shape
  the migration produces and mirror the existing smart-cast design. The ADR
  does not foreclose upgrading later.
- **Boxing seeds for captured pattern variables at every region entry** —
  rejected in favour of by-value capture, which is sound for a single-
  assignment local that is only visible after its assignment.
- **Reuse `name is Type` in boolean position** — rejected (ADR-0162
  rationale stands); the designation spelling is unambiguous and matches C#.
