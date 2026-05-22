# ADR-0007: String interpolation syntax — Kotlin-style

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 1 (implementation), Phase 0 (lock)
- **Related**: gaps doc §3.1.1; execution plan §0 D7, §1.1; design doc D7; ADR-0011

## Context

GSharp samples already pretend interpolation works (`"Count value: {i}"` in v0.1 Loop). The actual lexer ignores it. Three candidate syntaxes:

- **C#** `$"Hello, {name}, age {age + 1}"` — leading `$` sigil, all expressions in braces.
- **Kotlin** `"Hello, $name, age ${age + 1}"` — no sigil, `$ident` for bare references, `${expr}` for expressions.
- **Go** `fmt.Sprintf("Hello, %s, age %d", name, age + 1)` — no language-level interpolation.

## Decision

**Kotlin-style** in every double-quoted string literal:

- `$ident` interpolates the value of the named identifier.
- `${expr}` interpolates an arbitrary expression.
- `\$` escapes a literal `$`.
- Raw strings (backtick-delimited, ADR-0012) do **not** interpolate.

```gs
let name = "world"
let age  = 42
Console.WriteLine("Hello, $name, age ${age + 1}")
```

Lowering: simple cases (`"a$b"`) lower to `String.Concat(string[])`; complex cases with formatted expressions lower to `String.Format`. Decision per call site.

## Consequences

Positive:

- No sigil on the string literal — visually lighter than C#.
- Matches existing sample intent (`"{i}"` was always meant to be interpolation).
- Composes cleanly with Phase 1.6 `let` (`"$let_var"` works without ceremony).

Negative:

- Lexing interpolation inside string literals is non-trivial (nested braces, escaped `$`, raw-string exclusion). Reference C# Roslyn's `InterpolatedStringLexer` for shape; spec the grammar in ADR-0011.
- `$` is a legal identifier character in some languages; GSharp must reserve it inside string literals.

Neutral:

- Format specifiers (`${expr:format}`) deferred; revisit if user demand emerges.

## Alternatives considered

- **C#-style `$"..."`** with leading sigil: rejected for verbosity and to keep string syntax sigil-free.
- **Go-style `fmt.Sprintf`**: rejected; interpolation is a high-ROI ergonomics win and library-only formatting is regressive in 2026.
- **Both syntaxes**: rejected; one canonical way to do it is the goal.
- **Swift-style `\(expr)`**: rejected; the user's earlier local edit explored this, but Kotlin's `$ident` is shorter for the common case.
