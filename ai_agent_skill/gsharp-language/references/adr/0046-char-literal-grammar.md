# ADR-0046: `'c'` character literal grammar

- **Status**: Accepted
- **Date**: 2026-05-26
- **Phase**: Phase 8 — primitive coverage
- **Related**: issue #142, ADR-0044 (numeric primitive coverage), ADR-0011 (string interpolation grammar), ADR-0012 (raw string delimiter)

## Context

ADR-0044 adds `char` (`System.Char`) to GSharp's keyword set, but stops short of introducing a literal form for it. Without one, a user who wants a `char` value must either rely on context inference (`let c : char = 65` — a numeric cast) or borrow from a single-character string (`"A"[0]` — extra runtime work and an unobvious idiom). Both paths exist but read poorly and break parity with imported BCL APIs that overload on `char` vs. `int`.

The question is whether to introduce a dedicated `'c'` literal form and, if so, what its escape grammar looks like.

## Decision

GSharp adds a single-quote character literal. A character literal denotes a value of type `char` and is lexed as `CharacterToken`.

### Grammar

```
char_literal     = "'" char_content "'"
char_content     = unicode_value | escape_sequence
unicode_value    = any Unicode code unit other than "'", "\", and line terminators
escape_sequence  = "\" ( "'" | "\"" | "\\" | "0" | "a" | "b" | "f" | "n" | "r" | "t" | "v"
                       | "x" hex_digit{1,4}
                       | "u" hex_digit{4}
                       | "U" hex_digit{8} )
```

* Exactly one Unicode code unit (or one escape) is permitted between the delimiters. An empty literal (`''`) is a diagnostic.
* `\u` requires exactly four hex digits; `\U` requires exactly eight and must denote a value ≤ `U+FFFF` *or* a value in the supplementary planes — in the latter case the literal is rejected because `char` is a single UTF-16 code unit. Use a string literal plus `string.EnumerateRunes()` for supplementary characters.
* `\x` accepts one to four hex digits (C# style); the resulting value must fit in a UTF-16 code unit (≤ `0xFFFF`).
* Line terminators (`\n`, `\r`) inside a literal are diagnostics; use `\n` / `\r` escapes.
* Surrogate code units are *representable* (e.g. `'\uD83D'`) — this matches `System.Char`'s definition — but the lexer warns that paired surrogates require two `char`s.

### Static type

A character literal's static type is `char`. Unlike integer literals (ADR-0044), it is *not* untyped: `char` already participates in the implicit-conversion table to wider integers (`char → ushort/int/uint/long/…`), so the typed literal flows naturally into integer-typed targets without an explicit cast.

### Interaction with raw strings and interpolation

* Raw strings (ADR-0012) and interpolated strings (ADR-0011) are unaffected — they remain delimited by backticks and `"…"` respectively.
* A single-quote literal does **not** support interpolation (`'\(x)'` is a lex error). Interpolation is a string concern.

### Reserved future use

The `''` (empty char literal) and any escape sequence not listed above remain reserved. Future ADRs may extend the escape grammar (for example `\e` if a use case appears), but unknown escapes are diagnostics today, not silent fallbacks to the literal character.

## Consequences

* `char`-typed parameters of imported BCL APIs become writable in idiomatic GSharp: `Console.Write('\n')`, `someString.IndexOf('.')`.
* The lexer learns a new token form. Token-disambiguation between `'…'` and bare identifiers requires lookahead of one character (the opening `'`), already cheap in the current lexer.
* The full Unicode-aware escape set (`\u`, `\U`, `\x`) matches what GSharp already parses inside string literals (per ADR-0011); reusing the same scanner avoids divergence.
* Diagnostics expand: empty literal, unterminated literal, multi-codepoint literal, supplementary-plane `\U` literal, and disallowed line terminator each get their own error code.
* `typeof('a')` returns the `Type` for `System.Char`, on the same footing as the numeric primitives (issue #143).
* `'c'` is not a possible identifier prefix today, so no existing source breaks.

## Alternatives considered

* **No literal form — only `char(65)` casts and `"A"[0]`.** Rejected because it makes `char`-typed call sites read like an interop afterthought, and it requires an extra runtime indexing step for the string form.
* **Double-quoted single-character literal with a suffix (`"A"c`).** Rejected as visually clumsy and inconsistent with every other ADR-0044 suffix (which all attach to numeric literals).
* **Allow `'c'` to denote either a `char` *or* a single-character string by context.** Rejected because the surface ambiguity outweighs the convenience. `'A'` is always a `char`; if the user wants a string, they write `"A"`.
* **Adopt Go's runes (`'c'` is `int32`).** Rejected because GSharp's runtime is the CLR, where `char` is a 16-bit UTF-16 code unit. Forcing `'c'` to be 32-bit would diverge from every imported BCL signature. Users who want a Unicode rune can write `'A'` and cast it to `int` (the implicit-widening table covers that path).
