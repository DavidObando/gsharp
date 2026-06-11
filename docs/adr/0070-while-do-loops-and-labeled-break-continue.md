# ADR-0070: `while` / `do`-`while` statements and labeled `break` / `continue`

- **Status**: Accepted
- **Date**: 2026-06-11
- **Phase**: Phase 9 — language depth / control-flow ergonomics
- **Related**: ADR-0010 (aspirational samples), issues [#707](https://github.com/DavidObando/gsharp/issues/707) (this ADR), parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish)

## Context

G# inherited Go's "every loop is `for`" surface: `for { … }` is infinite, `for cond { … }` is the while-shape, `for init; cond; post { … }` is the C-style clause form, `for x := range coll { … }` (and `for x in coll { … }`) iterate, and `for i := a … b { … }` is the integer-range shape. There is no `while` keyword, no `do`/`repeat`-while, and `break` / `continue` always target the innermost enclosing loop.

The result is that G# can spell every loop, but two ergonomics gaps surface frequently in the conformance corpus and the docs site:

1. **`while` / `do`-`while` are not first-class.** Teaching material from the tour to the spec routinely says "G# has no `while` keyword; use `for cond`," which is correct but trips every reader who has written .NET, Kotlin, Swift, or TypeScript before. The "post-test" shape (`do { … } while cond`) is not expressible at all today without manually duplicating the body or using a flag — both ugly.
2. **`break` / `continue` cannot escape a nested loop.** Search-and-yield idioms ("scan a 2-D grid; the moment we find a hit, break out of both loops") have no clean spelling. The only workaround is a sentinel `bool found = false` flag plus an outer `if found { break }`, or refactoring the inner loop into its own function so `return` substitutes for a labeled break.

This ADR pins both decisions: add `while` and `do`-`while` to the language, and add Swift / Go-style labels to all five loop forms so `break` and `continue` can target an outer loop.

## Decision

### `while` loop

```
WhileStmt ::= 'while' Expression Block
```

`while cond { body }` evaluates `cond` (which must bind to `bool`); if true, executes `body` and re-tests; if false, falls through. It is a strict synonym for the existing `for cond { body }` shape — same binding rules, same lowering, same diagnostics. We chose to make `while` a reserved keyword (rather than a contextual alias) so that downstream tooling (highlighter, formatter, completion) treats it identically to `for`.

### `do`-`while` loop

```
DoWhileStmt ::= 'do' Block 'while' Expression
```

The body runs once unconditionally; afterwards `cond` is evaluated and the body re-runs while the condition holds. We picked the C# / Kotlin spelling `do { … } while cond` over Swift's `repeat { … } while cond`. Rationale:

- `do` is not currently a reserved word in G#. `repeat` is also free, but the C# spelling is the more familiar one to the .NET audience the language targets, and to every reader who has used JavaScript, Java, Kotlin, C, or C++.
- Swift had to rename `do`-`while` to `repeat`-`while` because Swift uses `do { … } catch { … }` for exception handling. G# uses `try { … } catch { … }`, so the `do` keyword has no collision.
- The `do` keyword is short enough that it does not visually compete with the body.

The trailing `while` keyword is the same token as the leading `while` of the prefix loop; the parser disambiguates by remembering it saw `do`.

### Loop labels

```
LabeledLoop ::= identifier ':' (ForStmt | WhileStmt | DoWhileStmt)
BreakStmt   ::= 'break' identifier?
ContinueStmt::= 'continue' identifier?
```

We picked the **Swift / Go** style — a bare identifier followed by a colon prefixed to a loop statement, and a bare identifier following `break` / `continue` — over Kotlin's `outer@ for ...` + `break@outer`. Rationale:

- The `@` token is already taken in G# by annotation syntax (ADR-0047). Re-using it for labels would create a parser fork that has to peek past identifiers to decide whether `@name` is an annotation or a label reference.
- The `outer:` form parses cleanly with one-token lookahead: at statement-start we already special-case `identifier := …` (short var decl); adding `identifier ':' (for|while|do) …` is a sibling rule with no ambiguity.
- The `break outer` / `continue outer` form follows the existing one-line restriction we use for `return value` — the optional identifier must be on the same source line as the `break`/`continue` keyword. This avoids accidentally swallowing a following statement that happens to start with an identifier.

The label namespace is local to the enclosing function (or top-level statement region). Labels do not nest into nested functions, deinit blocks, lambda bodies, async state machines, or `go`-spawned closures — each of those introduces a fresh function scope. A `break outer` / `continue outer` whose target is reachable across one of those boundaries is a binding error.

### Diagnostics

| Code   | Message                                                                                    | Trigger                                                                  |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| GS0120 | The keyword 'break'/'continue' can only be used inside of loops.                           | (existing) bare `break` / `continue` outside any loop.                   |
| GS0293 | No enclosing loop is labeled '\<name\>'.                                                   | `break <name>` / `continue <name>` where `<name>` is not on a live loop. |
| GS0294 | A label can only be applied to a loop statement.                                           | `outer: <non-loop-statement>` — the colon-prefix shape on, e.g., `if`.   |
| GS0295 | Label '\<name\>' shadows an enclosing loop label of the same name.                         | Nested `outer: for { … outer: while … }` — re-using a live label.        |

GS0293 cites the location of the `break` / `continue` keyword's label identifier. GS0294 cites the location of the label identifier; the inner statement still parses so subsequent diagnostics are not suppressed. GS0295 is a warning-tier diagnostic that flags shadowing without rejecting the program — the inner loop's label simply wins for any `break`/`continue` lexically inside it, matching the lexical-scoping rule that all other languages with labeled loops use.

### Binding and lowering

`while` and `do`-`while` bind directly to lowered `BoundBlockStatement` shapes, following the same pattern the binder already uses for `for cond` (`BindForConditionStatement`). They do **not** introduce new `BoundNodeKind` values, so none of the bound-tree machinery (`BoundTreeRewriter`, `BoundTreeWalker`, `BoundNodePrinter`, `SpillSequenceSpiller`, `EmitStatement`) needs new cases.

The `while` lowering is the existing `for cond` lowering:

```
{
    goto check
    body:
    <body>
    continue:
    check:
    if cond goto body
    break:
}
```

The `do`-`while` lowering tests at the bottom:

```
{
    body:
    <body>
    continue:
    if cond goto body
    break:
}
```

For loop labels, the binder maintains a parallel name → `(break, continue)` map on `BinderContext` (synchronized with `LoopStack`). `break <name>` / `continue <name>` consult that map and emit a `BoundGotoStatement` to the named loop's break/continue label. The break and continue labels themselves are unchanged — the same `BoundLabel` placeholders the loop body already references — so the existing flattening and emit passes see no new shapes.

### Reservation

`while` and `do` join the reserved-keyword set in ADR-0001 / ADR-0007 (lexical structure). User identifiers named `while` or `do` in scope at compile time emit the standard "reserved keyword cannot be used as an identifier" diagnostic at the lex/parse boundary, identical to how `for` / `break` / `continue` behave today.

## Consequences

**Positive.** All four control-flow shapes the issue requested (`while`, `do`-`while`, labeled `break`, labeled `continue`) become first-class with no surface fragility. Documentation no longer needs the "G# has no `while`, use `for cond`" caveat. The 2-D-search idiom gets a one-line spelling. The conformance harness gains coverage for both new keywords and labeled jumps. No new `BoundNodeKind` is added, so the bound-tree exhaustiveness tests stay quiet.

**Neutral.** `for cond` remains supported as an alias for `while`; existing samples and user code do not change. The C-style `for init; cond; post` clause is not aliased to anything new — it is the only shape that genuinely needs the three-part header.

**Negative.** Two more reserved keywords (`while`, `do`) collide with user identifiers in third-party codebases that import G# code. The migration cost is low (rename the conflicting locals) but non-zero. Loop labels add one more piece of surface to teach in the tour, though most readers already know the concept from a previous language.

## Alternatives considered

- **Kotlin `outer@` labels.** Rejected because the `@` token is reserved for annotations. Multi-token disambiguation at statement-start is achievable but adds parser complexity for no readability win over `outer:`.
- **Swift `repeat`-`while`.** Rejected because `do` is free in G# and is the more familiar spelling for the .NET / C / Kotlin / Java reader base.
- **`while` as a contextual keyword.** Rejected because it is the loop keyword in essentially every C-family language; making it a soft keyword would punish every reader's first instinct for no real upside.
- **Allow `break N` (numeric depth) instead of labels.** Rejected because numeric depths are fragile under refactoring (insert a new outer loop and every `break 2` becomes a silent bug).

## References

- Issue [#707](https://github.com/DavidObando/gsharp/issues/707) — this ADR's scope.
- Parent [#706](https://github.com/DavidObando/gsharp/issues/706) — control-flow polish umbrella.
- ADR-0047 — `@`-prefixed annotation syntax (why labels do not use `@`).
- ADR-0010 — aspirational-samples policy (drives the conformance sample added here).
