# ADR-0151: `if let` expressions

- **Status**: Accepted
- **Date**: 2026-07-26
- **Phase**: Phase 8 — language ergonomics / expression surface
- **Related**: ADR-0064 (if-expression and block-with-trailing-expression), ADR-0071 (`if let` / `guard let` bindings), ADR-0069 (smart-cast flow narrowing), ADR-0115 (cs2gs canonical forms), ADR-0150 (source decomposition conventions)

## Context

G# already has two independent features that users repeatedly try to combine:

- **ADR-0071 `if let` / `guard let`** — a *statement* that strips one nullable
  layer from an initializer and binds the underlying non-null value to a fresh
  name.
- **ADR-0064 `if` expressions** — a *value-producing* `if cond { … } else { … }`
  whose branch tails unify to a common result type.

There is no form that does both, so "produce a value from a nullable, or fall
back" has to be written as a `var` + statement `if let`, or as a `!!`-laden
ternary:

```gsharp
// today
var first string? = nil
if let copyright = GetCopyrights() {
    if copyright.Length > 0 {
        first = copyright[0]
    }
}
```

The gap also shows up in migration. cs2gs translates the very common C# shape

```csharp
public string? Copyright =>
    GetCopyrights() is { } copyright && copyright.Length > 0 ? copyright[0] : null;
```

by spilling the pattern scrutinee into a `let __spill0 = …` prologue (issue
\#1731 machinery, needed because a `{ } name` pattern reads the scrutinee more
than once) and re-asserting non-nullness at every binder reference. That forces
the expression-bodied property to become a block-bodied accessor and litters the
output with `__spill0` and repeated `!!`. A value-position `if let` is the
canonical G# form for exactly this shape.

## Decision

Add `if let` as a value-producing expression.

```ebnf
IfLetExpression  = "if" LetBindingList ( "&&" Expression )? BlockExpression
                   "else" ( IfExpression | IfLetExpression | BlockExpression ) .
LetBindingList   = LetBindingClause ( "," LetBindingClause )* .
LetBindingClause = "let" identifier TypeClause? "=" Expression .
BlockExpression  = "{" Statement* Expression "}" .
```

```gsharp
if let copyright = GetCopyrights() && copyright.Length > 0 {
    copyright[0]
} else {
    default(string?)
}

if let first = GetFirst(), let second = GetSecond(first) && second.IsValid {
    second
} else {
    fallback
}
```

### Semantics

1. **`else` is mandatory.** In value position a missing `else` reports
   **GS0276**, exactly as for the ADR-0064 if-expression.
2. **Bindings reuse ADR-0071 rules.** Every clause's initializer must have a
   nullable type; a non-nullable one reports **GS0296**. The optional explicit
   type clause (`if let s string = …`) names the *underlying* (non-null) type
   and is validated through the ordinary conversion classifier. The binding is
   stored at the nullable type and observed at the underlying type through the
   existing smart-cast narrowing path (ADR-0069).
3. **Left-to-right short-circuit.** Bindings are evaluated in source order; the
   first `nil` result skips every later initializer, the guard, and the
   then-block, and selects the `else` branch. Each initializer is evaluated at
   most once, and the first one is always evaluated.
4. **Later initializers see earlier bindings.** `if let b = B(a)` may reference
   an `a` bound to its left, already narrowed to its non-null underlying type.
5. **Optional guard.** A single top-level `&&` after the *final* binding
   introduces a `bool` guard. The guard runs only after every binding matched
   and sees all bound names narrowed. A `false` guard selects the `else`
   branch.
6. **Scope.** Bound names are visible in later initializers, in the guard, and
   in the then-block **only**. They are not in scope in the `else` branch and
   do not leak past the expression.
7. **Branch typing.** Then/else tails follow the ADR-0064 rules unchanged: a
   block in value position must end in a value-producing expression
   (**GS0277**), branches unify through the shared common-type computation, a
   failure reports **GS0263**, and a contextual target type (typed `let`,
   `return`, assignment RHS, argument position) is threaded into both branches.
8. **Chaining.** The `else` branch may be a block, a plain `if` expression, or
   another `if let` expression, in any combination (`else if let …`,
   `if … else if let …`).
9. **Statement forms are unchanged.** A statement-leading `if let` still parses
   as the ADR-0071 statement, and `guard let` is untouched. Source that
   compiled before continues to compile identically.

### The `&&` delimiter rule

`&&` is both grammar and an ordinary operator, so the boundary has to be
stated explicitly:

> Inside an `if let` **expression**, a binding initializer is parsed at the
> logical-and precedence tier. The first `&&` (or `||`) that would be a
> *top-level* operator of the final initializer instead terminates the binding
> list and starts the guard. A logical operator that genuinely belongs to an
> initializer must be parenthesized.

```gsharp
if let ok = (a && b) && ok { … } else { … }   // initializer `(a && b)`, guard `ok`
```

A right-associative `??` tail is still accepted unparenthesized in an
initializer (`if let v = a ?? b && v.IsValid { … }` binds `a ?? b` and guards on
`v.IsValid`), because `??` is the one realistic nullable-initializer operator
below the logical-and tier.

The **statement** form keeps parsing initializers with the full expression
grammar (`if let x = a && b { … }` still binds `a && b`); the statement form has
no guard clause, so there is nothing to delimit.

### Lowering

No new bound-node kind, emitter path, or interpreter case is introduced. The
expression lowers into the `BoundBlockExpression` / `BoundConditionalExpression`
pair that ADR-0064 already uses:

```text
if let a = e0, let b = e1 && g { T } else { F }

=>

({ let a = e0 } → a != nil ? ({ let b = e1 } → b != nil ? g : false) : false)
    ? T
    : F
```

Two properties drive this shape:

- **Short-circuit must live in a conditional, not in `&&`.** The interpreter's
  `EvaluateBinaryExpression` evaluates both operands of a logical operator
  before combining them, so hanging the later bindings off the right-hand side
  of an `&&` would evaluate them eagerly. `BoundConditionalExpression`
  evaluates only the selected arm in *both* back ends.
- **Each branch appears exactly once.** The emitter's slot dictionaries are
  keyed by bound-node identity (guarded by
  `SlotDictionaryAliasingAssertionTests`), so the same `then`/`else` node
  instance must not be reused in several tree positions. Putting the per-binding
  nesting in the *condition* keeps both arms single-instance regardless of the
  binding count.

The binding locals are declared through the same
`DeclarationBinder.BindVariableDeclaration` entry point the statement forms use,
so duplicate-name reporting and top-level variable shaping match. Their IL slots
are pre-allocated by the emitter's existing `BlockExpressionLocalCollector`,
which walks expression positions.

### Source layout

Per ADR-0150 the shared pieces are factored rather than duplicated:

- `Parser.IfLet.cs` — the `let`-binding header grammar (shared by `if let` /
  `guard let` statements and the expression) plus the expression form.
- `IfLetBindingSupport.cs` — the nullable-stripping / GS0296 / explicit-type
  rules, invoked from both `StatementBinder` and `ExpressionBinder` through
  collaborator callbacks.
- `ExpressionBinder.IfLet.cs` — the value-position binder and its lowering.

## Diagnostics

| Code | When |
| --- | --- |
| GS0276 | `if let` in value position with no `else` branch. |
| GS0277 | A then/else block with no trailing value-producing expression. |
| GS0263 | Then and else tails have no common result type. |
| GS0296 | A binding initializer's type is not nullable. |
| GS0004 | A binding name collides with an existing name in scope. |
| GS0017 | The guard is not convertible to `bool`. |

## cs2gs

`CSharpToGSharpTranslator` recognises the exact representable C# shape

```csharp
receiver is { } name [&& predicate]* ? whenTrue : whenFalse
```

and emits

```gsharp
if let name = receiver [&& predicate] { whenTrue } else { whenFalse }
```

mapping Roslyn's pattern local to the G# binding while the guard and true arm
are translated, so binder references print as the bare name — no `__spill`
temporary and no `!!`. Because the temporary disappears, the translated member
body is a single statement again and folds back to the idiomatic
expression-bodied arrow form.

The rewrite is deliberately conservative and falls back to the existing
spill-based `IfExpression` translation when any of the following holds:

- the pattern is not a bare `{ }` with a single variable designation (a type,
  property, or positional pattern changes the test, not just the binding);
- the receiver is not nullable in the translated G# type system (G# would
  report GS0296);
- the C# binder is reassigned anywhere in scope (G# `let` is immutable);
- the guard or the true arm contains a construct that needs a hoisted spill
  (another `is` pattern, an assignment, `++`/`--`, `out var`, a range, a
  `switch` expression) — such a spill would
  have to be hoisted *outside* the `if let`, where it would run
  unconditionally and could not see the binding.

## Considered alternatives

- **Reuse `IfExpressionSyntax` with an optional binding list.** Rejected: the
  binder would have to branch on "has bindings" at every step, and the
  statement/expression disambiguation in the parser is clearer with a distinct
  node.
- **A dedicated `BoundIfLetExpression` node.** Rejected: it would require new
  cases in the rewriter, walker, printer, spiller, emitter, and interpreter for
  no expressive gain — ADR-0064's node pair already expresses the shape.
- **`where` / `if` as the guard keyword instead of `&&`.** Rejected: `&&` is
  what the C# shape being migrated already reads like, and a new contextual
  keyword would be a larger grammar change than the one delimiter rule.
- **Evaluating every initializer eagerly (matching today's statement-form
  lowering).** Rejected: ADR-0071 specifies short-circuiting, and a value
  position makes the difference observable through side effects.

## Migration impact

Purely additive. `if let` / `guard let` statements, plain `if` expressions, and
every existing program are unaffected; the only newly-accepted source is
`if let` in a value position, which previously failed to parse or reported
GS0277.
