# ADR-0011: String interpolation grammar and lowering

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 1 (implementation: 1.1, 1.8)
- **Related**: ADR-0007 (interpolation choice); execution plan §1.1; gaps doc §3.1.1

## Context

ADR-0007 settled the Kotlin-style choice (`$ident`, `${expr}`, no sigil on the string literal). It left three sub-grammar questions open:

1. **Escape mechanism for a literal `$`.** ADR-0007 sketched `\$`, but GSharp double-quoted strings have no other escape sequences (`\n`, `\t`, etc. are not recognized today — see `ReadString` in the lexer pre-1.1). Adding a one-off `\$` escape would either require introducing a full escape sub-grammar or surfacing a confusing exception.
2. **Lowering strategy.** ADR-0007 said "simple cases lower to `String.Concat(string[])`, complex cases to `String.Format`." Both work, but the binder needs to convert non-string parts to string somewhere, and the current emitter does **not** support value-type instance dispatch (`Call` on `int.ToString` blows up at runtime — observed during Phase 1.1 implementation).
3. **Behaviour in raw (backtick) strings.** ADR-0007 said raw strings do not interpolate; ADR-0012 inherits that.

## Decision

### Grammar

Inside a double-quoted string literal:

```
Interpolation := "$" Identifier              -- $name
              |  "$" "{" Expression "}"       -- ${a + b}
              |  "$" "$"                       -- literal $
              |  "$" <any-other-char>          -- literal $ followed by that char (forward-compat)
```

- `Identifier` is the standard Unicode identifier production (ADR-0011a aka `docs/lexical.md`).
- `Expression` is any GSharp expression. The lexer captures the raw source between `${` and the balanced `}`; the parser invokes a fresh `SyntaxTree.Parse` on that source and lifts the first expression-statement's expression as the segment.
- **`$$` is the literal-`$` escape** (chosen over ADR-0007's tentative `\$` because there is no general backslash-escape grammar in GSharp strings today, and adding one is a separate ADR-sized question).
- A `$` not followed by `$`, an identifier-start, or `{` lexes as a literal `$`. This is forward-compatible: future grammar extensions can attach meaning to `$<digit>` etc. without breaking existing programs that happen to contain prose like `"$5"` (which produces literal text `$5`).
- Raw strings (ADR-0012) ignore `$` entirely.

### Lowering

The binder lowers an interpolated-string expression to a left-associative `+`-chain of `String`-typed sub-expressions:

```
"hi $name, ${a + b}"
  ⟶  "hi " + Convert.ToString(name) + ", " + Convert.ToString(a + b)
```

- Literal segments become `BoundLiteralExpression` strings.
- Expression segments are bound recursively; if the result type is not `String`, the binder wraps the expression in a static call to `System.Convert.ToString(<T>)`. `Convert.ToString` was chosen over instance `.ToString()` because the current emitter uses `Call` (not `Callvirt` with a `constrained.` prefix), which fails on value-type instance dispatch at runtime. `Convert.ToString` has a static overload set covering every primitive plus `object`, sidestepping the issue without requiring emitter changes.
- An empty interpolation collapses to the empty-string literal.
- Single-segment literal interpolations (e.g. `"hello"`) never enter this path — they remain `StringToken` and bind as plain literals.

`String.Format` is **not** used. The format-string detection (which calls go to `Format` vs `Concat`) carries no measurable benefit until escape-aware formatting (`${expr:N2}`) is on the table. ADR-0007 left format specifiers for "if user demand emerges"; we make the lowering choice independently.

## Consequences

Positive:

- No new escape sub-grammar needed. `$$` is self-explanatory and reversible (`"$$"` → `"$"` in the bound tree).
- The `Convert.ToString` lowering works on every primitive that has reflection metadata, with no emitter changes. We pay one extra IL call per interpolation segment vs hand-written `int.ToString`, which is acceptable for an MVP.
- The grammar leaves room for future `$<digit>` (positional args), `${expr:format}` (format specifiers), and `${expr?.member}` (null-conditional once nullables ship) without breaking existing programs.

Negative:

- `Convert.ToString` boxes value types via the `object` overload when an exact-type overload is missing. Negligible at runtime for the cases we care about, but worth revisiting if a hot path emerges.
- The brace scanner is balanced but **not string-literal aware**: `"${"abc"}"` will end the brace scan at the first `}`, which in this example never appears, producing an unterminated-string diagnostic. Programs that need to embed strings inside `${...}` must extract a `let` binding. We accept this; fixing it requires a real sub-lexer.
- Surrogate-pair identifiers in `$ident` are not supported (inherits the same limitation as identifier lexing — see `docs/lexical.md`).

Neutral:

- `\$` may be added as an alias for `$$` if/when a general escape grammar lands; the choice here does not foreclose that.

## Alternatives considered

- **`\$` escape (per ADR-0007 sketch).** Rejected because GSharp strings have no other backslash escapes today; introducing one for `$` alone is asymmetric. Revisit when escape sequences are spec'd.
- **`%` interpolation (Python printf-style).** Rejected — Python deprecated this in favor of f-strings; we should not adopt a deprecated grammar.
- **Lowering to `String.Format`.** Considered for "complex" cases. Rejected for Phase 1: it requires building a format string at bind-time and an `object[]` arg pack, both adding lowering complexity for no observable runtime gain. Can be reintroduced behind a heuristic if profiling motivates it.
- **Lowering to instance `.ToString()`.** Rejected because the current emitter does not support value-type instance dispatch. Re-enable once Phase 2 (constrained-call emit support) lands; until then `Convert.ToString` is the safe path.
