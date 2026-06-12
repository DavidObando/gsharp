---
title: "Lexical structure"
sidebar_position: 2
draft: false
---

# Lexical structure

This guide explains the tokens G# recognizes today. For the normative grammar, see the [language specification](/docs/ref/spec).

## Source text and comments

G# source is Unicode text. Whitespace separates tokens but is otherwise insignificant outside literals. Use `//` for line comments and `/* ... */` for block comments. Block comments do not nest. The compiler lexer supports block comments even though some older editor documentation is behind the implementation.

## Identifiers and keywords

Identifiers start with a Unicode letter or `_` and continue with Unicode letters, digits, or `_`. The lexer uses .NET Unicode classification, so non-ASCII letters are accepted.

Reserved keywords include declarations (`package`, `import`, `type`, `func`, `var`, `let`, `const`), control flow (`if`, `else`, `for`, `switch`, `case`, `default`, `break`, `continue`, `return`), concurrency (`go`, `chan`, `select`, `scope`), exceptions (`try`, `catch`, `finally`, `throw`), and modifiers such as `public`, `internal`, `private`, `open`, `override`, and `sealed`.

Some words are contextual: `record`, `data`, `inline`, `prop`, `event`, `shared`, `init`, `get`, `set`, `add`, `remove`, `raise`, `in`, `out`, `yield`, `with`, `typeof`, `nameof`, and `make` are identifiers except in the syntax positions that give them special meaning.

## Numeric literals

Use explicit prefixes for non-decimal integers: `0x` for hexadecimal, `0o` for octal, and `0b` for binary. Underscores can group digits, including immediately after a base prefix, but cannot be trailing.

Integer suffixes are case-insensitive: `L` for `int64`, `U` for `uint32`, and `UL` or `LU` for `uint64`. Unsuffixed decimal integers are `int32`; unsuffixed non-decimal values fitting `uint32` are bit-cast to `int32` for compatibility.

Floating literals are decimal only. Valid forms include `1.5`, `.5`, `1e10`, and `1.5e-3`. The current lexer does not treat `1.` as a float because the dot would conflict with member access. Floating suffixes are `F` for `float32`, `D` for `float64`, and `M` for `decimal`.

The numeric design is grounded in [ADR-0044](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0044-numeric-primitive-coverage.md) and [ADR-0049](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0049-width-bearing-integer-names.md).

## Characters and strings

A character literal is one UTF-16 code unit or escape in single quotes. Supported escapes include common C-style escapes, hex escapes, and Unicode escapes constrained to one code unit. See [ADR-0046](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0046-char-literal-grammar.md).

Normal strings are double-quoted. In the implementation snapshot, doubled quotes produce a literal quote; backslash escapes are not interpreted by the normal string lexer. Raw strings are backtick-delimited, can span lines, normalize CR and CRLF to LF, and do not process escapes or interpolation. See [ADR-0012](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0012-raw-string-delimiter.md).

Interpolated strings are sigil-free: holes live inside ordinary double-quoted strings rather than behind a C#-style `$"…"` prefix. A hole is `$name` (a single identifier) or a braced `${expression}`, optionally with an alignment and format clause, `${expr,alignment:format}`. Use `$$` for a literal dollar sign; there is no `{{`/`}}` brace escaping. The braced-hole scanner is delimiter-aware — it balances brackets, skips nested string and char literals and comments, and allows the expression to span lines — so `${dict["k"]}`, `${cond ? "a" : "b"}`, and multiline holes all work. Holes are real code: hover, go-to-definition, find-references, completion, and signature help all work inside `${…}`.

```gsharp title="samples/InterpolatedString.gs"
package InterpolatedString

let name = "world"
let n = 6
Console.WriteLine("Hello, $name!")
Console.WriteLine("answer = ${n * 7}")
Console.WriteLine("$$ stays literal")
```

Interpolation rationale: [ADR-0007](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0007-string-interpolation.md), [ADR-0011](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0011-string-interpolation-grammar.md), and [ADR-0055](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0055-string-interpolation-revamp.md) (delimiter-aware grammar, alignment/format clauses, late lowering, and IDE support).

## Operators and punctuation

G# includes Go-like operators plus CLR-oriented additions: null assertion `!!`, null-conditional access `?.`, null-conditional indexing `?[` (ADR-0073), null coalescing `?:`, null-coalescing compound assignment `??=` (ADR-0072), channel receive and send `<-`, switch-expression arrows `->`, and annotations introduced by `@`. Compound assignment exists for arithmetic, bitwise, bit-clear, and shift operators.

`while`, `null`, `nameof`, `typeof`, and `make` are not all keywords. `while` and `null` are not implemented language forms; use `for condition { ... }` and `nil`.
