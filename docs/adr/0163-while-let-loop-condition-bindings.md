# ADR-0163: `while let` loop-condition bindings

- **Status**: Accepted
- **Date**: 2026-08-11
- **Phase**: Language control flow / migration fidelity
- **Related**: ADR-0069 (smart-cast narrowing), ADR-0070 (`while` and loop labels), ADR-0071 (`if let` / `guard let`), ADR-0160 (`as` yields nullable), [#3352](https://github.com/DavidObando/gsharp/issues/3352), parent [#3347](https://github.com/DavidObando/gsharp/issues/3347)

## Context

G# can bind a nullable value in an `if let` then-region or after an exiting
`guard let`, but a pre-test loop condition could not introduce a fresh
non-null name:

```gs
while let item = Next() {
    Consume(item)
}
```

Before this ADR, the parser routed `while` only to the ordinary boolean
condition grammar and rejected `let` with GS0005. Programs had to spell an
infinite loop with a declaration and nil guard in its body.

The missing form also forced cs2gs spill site L1
(`HoistLoopConditionClauseCore`) to rewrite every C# while-pattern condition,
including a trivial positive declaration pattern:

```csharp
while (Next() is string text) { Consume(text); }
```

The rewrite worked, but produced a `while true` loop, a body prologue, and
sometimes a synthetic `__scrutineeN` name even though the source condition had
a natural binder.

## Decision

Add a nullable-binding pre-test loop:

```ebnf
WhileLetStmt   ::= "while" LetBindingList Statement
LetBindingList ::= LetBindingClause ("," LetBindingClause)*
LetBindingClause ::= "let" identifier TypeClause? "=" Expression
```

The binding clauses use exactly the grammar and nullable-stripping rules shared
by statement-form `if let` and `guard let`.

```gs
while let line = reader.ReadLine() {
    Console.WriteLine(line.Length)
}

while let left string = NextLeft(), let right = NextRight() {
    Consume(left, right)
}
```

### Binding and scope

Each initializer must have nullable type `T?`; otherwise GS0296 is reported.
An optional type clause names the underlying non-null type, as in
`while let text string = maybeText`.

The introduced locals:

- are immutable `let` bindings;
- are observed at their underlying non-null types inside the loop body;
- are visible only in the loop body, including nested statements and guard
  code emitted there by migration tools;
- are not visible after the loop or in any initializer in the same header;
- may shadow an outer local using the existing nested-scope rules.

Multiple clauses follow statement-form `if let` semantics: their initializers
are evaluated left to right before the combined nil test. The body runs only
when every binding is non-nil. Header initializers bind in the enclosing scope,
so a binding introduced by one clause is not available to another clause.
This differs from the value-producing ADR-0151 `if let` expression, whose
binding chain short-circuits and permits a later initializer to consume an
earlier narrowed binding.

`while let` has no header-level `&&` guard. Statement-form binding initializers
retain the full expression grammar, matching ADR-0071. A migration tool can
preserve `pattern && predicate` by placing a negated predicate guard at the
start of the body, where the binding is in scope.

### Evaluation and control flow

Every binding initializer is evaluated once before the first attempted
iteration and once again after every completed body iteration. A failing test
still performs that condition evaluation before the loop terminates.

`continue` targets the condition check, not the top of the body, so all
initializers are re-evaluated. `break` exits without another evaluation.
Labeled `break name` and `continue name` use ADR-0070's existing loop stack and
work identically for `while let`. An awaited initializer is valid inside an
`async func`; the async spiller sees only existing lowered bound nodes.

There is no corresponding `do let` form. A post-test loop cannot make a
condition binding available during its unconditional first body execution.

### Lowering

No new bound-node kind is introduced. The statement lowers to existing
declaration, label, goto, and conditional-goto nodes:

```text
{
    goto check
body:
    <body, bindings narrowed to T>
continue:
check:
    let a T1? = e1
    let b T2? = e2
    if a != nil && b != nil goto body
break:
}
```

Placing declarations at `check` gives the required first evaluation,
per-iteration re-evaluation, and `continue` behavior. A loop-local
`BoundScope` contains both storage locals. `BindConditionedLoopBody` supplies
body narrowing and the existing definite-assignment/back-edge analysis.

Because lowering uses existing nodes, bound-tree visitors and rewriters,
control-flow analysis, async spilling, IL emission, and bound-tree printing
need no new cases.

### Syntax and tooling

`WhileLetStatementSyntax` is a dedicated statement node, parallel to
`IfLetStatementSyntax`. It contains the `while` token, shared
`IfLetBindingClauseSyntax` list, and body statement. Generic syntax traversal
discovers all children, so syntax printers and token-based formatting require
no special production path.

Language-server semantic lookup treats each binding-clause identifier as a
local declaration. Hover, definition, references, and rename therefore resolve
the declaration and body uses to the same symbol while respecting the
loop-only scope.

### cs2gs

cs2gs emits native `while let` for positive, single-binder C# patterns when the
form preserves source behavior:

```csharp
while (Next() is { } item) { ... }
while (Next() is string text) { ... }
while (Next() is int value && value > 0) { ... }
```

becomes, respectively:

```gs
while let item = Next() { ... }
while let text = Next() as string { ... }
while let value = Next() as int32? {
    if !(value > 0) { break }
    ...
}
```

The value-type target is nullable because G# testing conversion and
`while let` jointly implement C#'s type test and unboxing bind.

The translator decides eligibility before translating any subexpression.
It keeps the existing L1 hoist for patterns without one faithful binding,
reassigned pattern locals, ref-like or unsupported target types, and receiver
or guard expressions that require a spill seam. `do`-`while` also keeps the
old path because its binder cannot be in scope for the first body execution.

## Diagnostics and recovery

- **GS0296** now names `while let` alongside `if let` and `guard let` when an
  initializer is non-nullable.
- **GS0525** points boolean pattern bindings at `while let` when the binding is
  needed for a loop.
- Missing identifiers, `=`, initializers, separators, or bodies use standard
  parser recovery. The parser retains the `WhileLetStatementSyntax` node so
  later statements remain discoverable and semantic diagnostics can continue.

## Consequences

Positive:

- nullable-producing iterators and readers gain a direct pre-test loop;
- bindings are narrowed, body-scoped, async-safe, and compatible with labeled
  `break` / `continue`;
- cs2gs removes the unconditional L1 hoist for common positive while-patterns;
- generated G# preserves condition evaluation count and compiles through the
  normal parser, binder, lowerer, and emitter.

Neutral:

- ordinary `while Expression` and every existing `for` spelling are unchanged;
- multiple binding clauses retain statement-form `if let` evaluation behavior;
- unsupported C# pattern shapes still use the proven hoist fallback.

Negative:

- one syntax-node kind and one cs2gs code-model statement join exhaustive
  surface inventories;
- `while let` cannot express a separate boolean header guard, so cs2gs emits
  such a guard as the first body statement.

## Alternatives considered

- **Keep `while true` plus body guard.** Rejected: verbose source, synthetic
  names, and an unconditional translator spill for a common binding shape.
- **Allow a binding in boolean `is`.** Rejected by ADR-0162: expression
  position has no sound declaration region. `while let` names the region
  explicitly.
- **Add a new bound while-let node.** Rejected: existing declarations, labels,
  gotos, narrowing, flow analysis, and emit already model the semantics.
- **Add `while let ... && guard` grammar.** Rejected for now: statement-form
  `if let` has no such delimiter and its initializer owns top-level `&&`.
  Body-prologue guarding is equivalent and keeps the shared grammar stable.
- **Translate every C# while pattern to `while let`.** Rejected: property,
  recursive, negated, multi-binder, reassigned-local, and spill-requiring
  patterns are not all faithfully representable by nullable binding alone.
