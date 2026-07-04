# ADR-0139: general `goto` / label statements

- **Status**: Accepted
- **Date**: 2026-07-04
- **Phase**: Phase 9 — language depth / control-flow ergonomics
- **Related**: ADR-0070 (`while`/`do`-`while`, labeled `break`/`continue`), issue [#1884](https://github.com/DavidObando/gsharp/issues/1884)

## Context

ADR-0070 added `name: loop-statement` labels, but restricted them to loop
statements — the label could only be consumed by a labeled `break`/`continue`.
`cs2gs` (the C#→G# migration tool) has no mapping for C#'s general
`goto label;` / `label: statement;` / `goto case K;` / `goto default;` and
falls back to a `CS2GS-GAP` diagnostic for all four (issue #1884).

Under the hood, G# already has everything a general `goto`/label needs:
`BoundGotoStatement` and `BoundLabelStatement` are the same bound nodes the
`for`/`while`/`do`-`while` lowering has emitted since ADR-0070 (`goto check`,
`goto body`, …), and both the IL emitter and the tree-walking evaluator
resolve them generically — including a jump out of a nested block to a label
in an enclosing one (the exact shape `break`/`continue` already relies on).
The only missing piece was surface syntax and a name-to-label binding table.

## Decision

`label:` can now prefix **any** statement, not only a loop:

```
LabeledStatement ::= identifier ':' Statement
GotoStatement    ::= 'goto' identifier
```

- A label on a loop statement is unchanged from ADR-0070 — it names the loop
  for a labeled `break`/`continue`.
- A label on any other statement declares a **`goto` target**. `goto name`
  (the target must be on the same source line as the keyword, mirroring the
  `break`/`continue` label rule) jumps to it.
- The label namespace is local to the enclosing function, matching ADR-0070's
  existing rule for loop labels. A `goto` may forward-reference a label
  declared later in the same function.
- `goto` can jump out of a nested block (`if`, `for`, `try`, …) to a label in
  an enclosing block — the same escape the lowered `break`/`continue` already
  performs. Jumping *into* a nested block is not supported (matching C#'s own
  restriction; there is no scope-entry bookkeeping for it).

### Binder

The binder pre-registers nothing eagerly; instead each function's
`BinderContext` carries a `name → BoundLabel` map (`UserLabels`) built
on demand:

- `goto name` calls `GetOrCreateUserLabelForGoto`, which returns the existing
  `BoundLabel` or creates a placeholder (a forward reference) and records the
  reference location in `UnresolvedGotoLabels`.
- `label: statement` (non-loop) calls `DefineUserLabel`, which reuses any
  placeholder, or creates a fresh label, and reports GS0470 if the name is
  already defined in this function.
- Once the enclosing function/method/constructor/accessor/local-function body
  (or, for top-level statements, all global statements together) finishes
  binding, `FinalizeUserLabels` reports GS0469 for any name left in
  `UnresolvedGotoLabels` — a `goto` to a label that was never declared.

`BindLabeledStatement`'s non-loop path binds the inner statement normally and
wraps `[BoundLabelStatement, boundInner]` in a `BoundBlockStatement` purely
for return-shape convenience: the existing `Lowerer.Flatten` pass inlines
nested `BoundBlockStatement`s into their parent's statement list, so this
introduces no new binder scope — `label: var x = 1` still declares `x` into
the enclosing block, exactly like C#.

No new `BoundNodeKind` is introduced (`BoundGotoStatement`/
`BoundLabelStatement` already existed), so `ControlFlowGraph`,
`RefKindDefiniteAssignmentAnalyzer`, `SlotPlanner`, `MethodBodyEmitter`, and
the evaluator needed no changes — they already handle these bound nodes
generically.

### Diagnostics

| Code   | Message                                                  | Trigger                                          |
| ------ | --------------------------------------------------------- | ------------------------------------------------- |
| GS0469 | The label '\<name\>' does not exist in the current context. | `goto` to a name never declared in this function.  |
| GS0470 | The label '\<name\>' is already defined in this function.   | Two `label:` declarations with the same name.      |

GS0294 ("a label can only be applied to a loop statement") is retired — the
shape it flagged is now valid.

### `cs2gs` mapping (issue #1884)

With general `goto`/label available, the four gapped C# constructs map
directly:

- `LabeledStatement` → G# `label: statement`.
- `GotoStatement` → G# `goto label`.
- `GotoCaseStatement` / `GotoDefaultStatement` → C#'s `goto case K;` /
  `goto default;` jump straight into a `switch` arm's statement list without
  re-evaluating the switch expression, and (per C# semantics) fall through
  into any following arm exactly as `case K:` would. `cs2gs` keeps the
  `switch` a native G# `switch` and, for each arm actually targeted by a
  `goto case`/`goto default` elsewhere in the same `switch`, prefixes that
  arm's translated body with a synthesized label (`__gotoCase<pos>` /
  `__gotoDefault<pos>`, keyed by the target case/default label's own source
  position so it is unique and stable across the two translator call sites
  that must agree on the name); the `goto case`/`goto default` statement
  itself lowers to a plain `goto` of that label. G# arms are fully flattened
  by `Lowerer.Flatten` before evaluation/emission (the same mechanism that
  lets a `goto` cross sibling `if`/`while` blocks), so a `goto` landing
  inside one arm's body and falling through into the next arm's statements
  works with no special-casing — no `if`/`else if` rewrite of the `switch`
  is needed.

## Consequences

**Positive.** `cs2gs` can now migrate C#'s full `goto`/label surface,
including the `goto case`/`goto default` fall-through forms, with faithful
semantics. No gsc runtime or emit changes were needed — only surface syntax
and a label-name binder.

**Negative.** Unstructured control flow is easy to write incorrectly by hand;
G# still has no `goto`-into-scope diagnostic beyond "does not parse as a
label the flattener can reach," matching C#'s own coarse-grained restriction
rather than a full definite-assignment-aware jump analysis.

## Alternatives considered

- **Lower `goto`/labels entirely in `cs2gs`** (e.g. rewrite backward-`goto`
  loops into `for`/`while`). Rejected: general forward/backward `goto` and
  `goto case`/`goto default` do not have a single structured G# equivalent
  that preserves semantics in every shape; the underlying bound-tree
  machinery already supports arbitrary labels/gotos, so exposing surface
  syntax is both less code and strictly more general than pattern-matching
  specific `goto` idioms in the translator.
