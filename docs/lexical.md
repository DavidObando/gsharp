# GSharp Lexical Specification

This document describes the lexical structure of GSharp. The grammar follows Go closely, with deliberate divergences noted inline.

## Source representation

Source files are UTF-8 encoded Unicode text. The lexer treats LF (`\n`), CR (`\r`), and CRLF as line terminators; raw string literals normalize CR and CRLF to LF when their contents are exposed to the bound tree.

## Identifiers

```
identifier = letter { letter | unicode_digit }
letter     = unicode_letter | "_"
```

* `unicode_letter` is any Unicode code point classified as a letter (categories `Lu`, `Ll`, `Lt`, `Lm`, `Lo`, `Nl`).
* `unicode_digit` is any Unicode code point classified as a decimal digit (`Nd`).
* The underscore (`_`) is a letter.

Implementation note: the lexer uses .NET's `char.IsLetter` and `char.IsLetterOrDigit`, which are Unicode-aware. Examples of valid identifiers: `café`, `π`, `日本語`, `Москва`, `Δx`, `α2β`, `_underscore`. Identifiers starting with a digit are not permitted (`2π` lexes as `NumberToken("2")` followed by `IdentifierToken("π")`).

Identifiers consisting of a surrogate pair (Unicode code points beyond U+FFFF) are not currently supported and will fall through to the bad-character path.

## Keywords

Keywords are reserved and may not be used as identifiers. See `SyntaxFacts.GetKeywordKind` for the canonical list.

## Numeric literals

GSharp supports the following integer literal forms:

| Form    | Prefix    | Digits         | Example       |
| ------- | --------- | -------------- | ------------- |
| Decimal | (none)    | `0`–`9`        | `42`, `1_000` |
| Hex     | `0x` / `0X` | `0`–`9`, `a`–`f`, `A`–`F` | `0xff`, `0xDEAD_BEEF` |
| Octal   | `0o` / `0O` | `0`–`7`        | `0o755`       |
| Binary  | `0b` / `0B` | `0`, `1`        | `0b1010_1010` |

* Underscores (`_`) may appear between digits and immediately after a base prefix for readability (`0x_FF` is valid). A trailing underscore (`1_`) or an underscore as the only digit after a prefix (`0x_`) is rejected.
* GSharp does **not** support Go's leading-zero octal form (e.g., `0755`); the explicit `0o755` is required. This keeps the grammar unambiguous for future floating-point literal work.

## String literals

GSharp has two string forms:

1. **Interpreted strings** delimited by `"…"`. Escape sequences are processed.
2. **Raw strings** delimited by backticks (`` `…` ``). Contents are taken verbatim with no escape processing. Multi-line raw strings are allowed; CR and CRLF in the source are normalized to LF in the literal value. Embedded backticks are not representable; concatenate with `+` if needed.

## Comments

Single-line comments start with `//` and run to the end of the line. (Block-comment syntax is not yet implemented; see the execution plan.)

## Whitespace and line terminators

Spaces, tabs, and line terminators are insignificant outside of string literals.

## See also

* `docs/coverage-matrix.md` — language-construct coverage matrix.
* `docs/adr/0011-string-interpolation-grammar.md` — interpolation sub-grammar and lowering.
* `docs/adr/0012-raw-string-delimiter.md` — rationale for backtick raw strings.
