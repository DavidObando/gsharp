# ADR-0012: Raw string delimiter — backtick (`` ` ``)

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 1 (implementation: 1.2, 1.8)
- **Related**: ADR-0007 (interpolation choice — raw strings do not interpolate); ADR-0011 (interpolation grammar); execution plan §1.2

## Context

GSharp needs a "no-escapes, multi-line" string literal form for regexes, paths, JSON snippets, embedded SQL, and the like. Three precedents:

| Language | Delimiter | Notes |
| --- | --- | --- |
| Go | `` ` `` (backtick) | Multi-line; no escapes; embedded `` ` `` not representable (must concatenate). |
| C# | `@"..."`, `"""..."""` | `@` is verbose-string; `"""` is C# 11 raw string with arbitrary delimiter sizing. |
| Rust | `r"..."`, `r#"..."#`, `r##"..."##` | Hash-balanced; arbitrarily nestable. |

GSharp's grammar is Go-flavored, so the backtick is the natural fit. The question is whether we accept the "embedded backtick not representable" limitation (Go's accepted trade-off) or invent something more flexible (C# 11 / Rust style).

## Decision

**Backtick (`` ` ``) is the raw-string delimiter.** Behaviour:

- All characters between the opening and closing backticks are taken verbatim — no `\n`, `\t`, etc. escape processing.
- Multi-line raw strings are allowed. The lexer normalizes CR (`\r`) and CRLF (`\r\n`) inside the literal to LF (`\n`) so the value seen by the bound tree is stable across line-ending conventions of the source file. (Matches Go's spec.)
- `$ident` / `${expr}` interpolation is **not** processed (raw strings are verbatim — period).
- Embedded backticks are not representable inside a single literal. Workaround: concatenate with `+`, or use a double-quoted interpolated string with `${\"`\"}` (not yet possible — see ADR-0011 known issues).

Token kind: `SyntaxKind.StringToken` (same as interpreted-string non-interpolated form). The bound tree does not distinguish raw vs interpreted strings.

## Consequences

Positive:

- One-character delimiter, easy to type, visually distinct from regular strings.
- Matches Go exactly, so Go developers will be immediately at home.
- The lexer change is small and self-contained (`ReadRawString` in `Lexer.cs`).

Negative:

- No way to put a backtick inside a raw string. Concrete impact: regex literals that contain `` ` `` (rare) need concatenation. We accept the trade-off; Go has lived with it for fifteen years.
- The verbatim multi-line semantics mean indentation inside a raw string ends up in the value. There is no "strip common leading whitespace" pass (Python's `textwrap.dedent`, C# 11 raw-string indentation). Adding one is a non-breaking Phase 3+ enhancement.

Neutral:

- The CRLF/CR-to-LF normalization is a runtime convenience; it diverges from "verbatim" in the strictest sense, but matches Go and produces source-portable behaviour.

## Alternatives considered

- **C# 11 `"""..."""` raw strings with arbitrary delimiter sizing.** Solves the embedded-backtick problem and supports common-leading-whitespace stripping. Rejected for Phase 1 because (a) the grammar is significantly more involved (triple-quote start, optional indentation prefix on the closing quote line), and (b) Go-flavor consistency outweighs the marginal benefit. May revisit if the limitation bites in practice.
- **`@"..."` verbose-strings (C# pre-11).** Rejected because it conflicts with potential future uses of `@` (decorators, attribute marker, identifier escape) and is less visually distinct than the backtick.
- **`r"..."` / `r#"..."#` (Rust-style).** Rejected because we have no use for a leading-letter literal prefix elsewhere, and the hash-balanced extension is unnecessary for Phase 1.
- **`r###"..."###` with sized delimiters.** Same as Rust above. Revisit alongside C# 11-style triple-quote if embedded-backtick becomes painful.
