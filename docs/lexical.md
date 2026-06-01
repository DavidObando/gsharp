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

## Predeclared types

The following type names are predeclared in the universe scope and resolved by `Binder.LookupType`. They are not lexical keywords — they may appear anywhere a type identifier is permitted, but rebinding them is rejected by the binder.

| Name       | CLR type            | Notes                                                              |
| ---------- | ------------------- | ------------------------------------------------------------------ |
| `bool`     | `System.Boolean`    | `true` / `false` literals.                                         |
| `int8`    | `System.SByte`      | 8-bit signed integer.                                              |
| `uint8`     | `System.Byte`       | 8-bit unsigned integer.                                            |
| `int16`    | `System.Int16`      | 16-bit signed integer.                                             |
| `uint16`   | `System.UInt16`     | 16-bit unsigned integer.                                           |
| `int32`      | `System.Int32`      | Default integer literal type.                                      |
| `uint32`     | `System.UInt32`     | Reached via the `U` literal suffix.                                |
| `int64`     | `System.Int64`      | Reached via the `L` literal suffix.                                |
| `uint64`    | `System.UInt64`     | Reached via the `UL` / `LU` literal suffix.                        |
| `nint`     | `System.IntPtr`     | Native-sized signed integer.                                       |
| `nuint`    | `System.UIntPtr`    | Native-sized unsigned integer.                                     |
| `float32`  | `System.Single`     | 32-bit binary floating point. `F` literal suffix.                  |
| `float64`  | `System.Double`     | 64-bit binary floating point. Default float literal type. `D` literal suffix. |
| `decimal`  | `System.Decimal`    | 128-bit base-10 floating point. `M` literal suffix.                |
| `char`     | `System.Char`       | 16-bit Unicode code unit. Written with single quotes — `'a'`, `'\n'`, `'\u00e9'`. See ADR-0046. |
| `string`   | `System.String`     | UTF-16 immutable string.                                           |
| `object`   | `System.Object`     | Universal upper bound — every type implicitly widens to `object`. See ADR-0045. |

See ADR-0044 (numeric primitive coverage), ADR-0045 (`object` as universal upper bound), and ADR-0046 (`char` literal grammar) for design rationale.

## Numeric literals

GSharp supports the following integer literal forms:

| Form    | Prefix    | Digits         | Example       |
| ------- | --------- | -------------- | ------------- |
| Decimal | (none)    | `0`–`9`        | `42`, `1_000` |
| Hex     | `0x` / `0X` | `0`–`9`, `a`–`f`, `A`–`F` | `0xff`, `0xDEAD_BEEF` |
| Octal   | `0o` / `0O` | `0`–`7`        | `0o755`       |
| Binary  | `0b` / `0B` | `0`, `1`        | `0b1010_1010` |

* Underscores (`_`) may appear between digits and immediately after a base prefix for readability (`0x_FF` is valid). A trailing underscore (`1_`) or an underscore as the only digit after a prefix (`0x_`) is rejected.
* GSharp does **not** support Go's leading-zero octal form (e.g., `0755`); the explicit `0o755` is required. This keeps the grammar unambiguous for floating-point literals.

### Floating-point literals

A decimal literal containing a `.` fractional part and/or a `e` / `E` exponent is a floating-point literal. The leading integer part is optional (`.5` is valid); the trailing fractional part is optional after a `.` (`5.` is valid). Underscores are permitted between digits in the integer, fractional, and exponent parts, but not adjacent to the `.` or to the sign of the exponent. Examples: `3.14`, `.5`, `5.`, `1e10`, `1.5E-3`, `1_000.000_1`.

The default type of an unsuffixed floating-point literal is `float64`.

### Numeric literal suffixes

A case-insensitive type-pin suffix may follow the digit body. The suffix is consumed by the lexer and the literal's static type is the corresponding predeclared type.

| Suffix     | Type      | Legal on |
| ---------- | --------- | -------- |
| `L` / `l`  | `int64`    | integer bodies (decimal, hex, octal, binary) |
| `U` / `u`  | `uint32`    | integer bodies |
| `UL` / `LU` (any casing) | `uint64` | integer bodies |
| `F` / `f`  | `float32` | decimal integer or floating-point bodies |
| `D` / `d`  | `float64` | decimal integer or floating-point bodies |
| `M` / `m`  | `decimal` | decimal integer or floating-point bodies |

`F`, `D`, and `M` are **not** legal on hex/octal/binary integer bodies because `F` and `D` are themselves hex digits — `0xFFf` is the hex number ending in three `F` digits, not a float-suffixed value.

A decimal literal with no suffix and no fractional/exponent part has type `int32`; if its value exceeds `Int32.MaxValue` the binder reports a diagnostic, so an explicit `L` suffix is required to write a 64-bit literal.

## Character literals

A character literal is a single Unicode code unit enclosed in single quotes (`'`). The contents are processed exactly like an interpreted string of length one — escape sequences (`\\`, `\'`, `\"`, `\0`, `\a`, `\b`, `\f`, `\n`, `\r`, `\t`, `\v`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`) are recognized. A character literal has type `char`. See ADR-0046 for the full grammar and rationale.

## String literals

GSharp has two string forms:

1. **Interpreted strings** delimited by `"…"`. Escape sequences are processed.
2. **Raw strings** delimited by backticks (`` `…` ``). Contents are taken verbatim with no escape processing. Multi-line raw strings are allowed; CR and CRLF in the source are normalized to LF in the literal value. Embedded backticks are not representable; concatenate with `+` if needed.

### String interpolation

Interpreted strings support interpolation (ADR-0055):

* `$ident` — inserts the value of a simple identifier: `"hi $name"`.
* `${expr}` — inserts an arbitrary expression: `"sum=${a + b}"`, `"type=${x.GetType()}"`.
* `${expr,alignment}` — pads the rendered value to a signed field width: positive right-justifies, negative left-justifies. `"[${name,5}]"` → `"[   hi]"`, `"[${name,-5}]"` → `"[hi   ]"`. The alignment must be a constant integer (otherwise **GS0220**).
* `${expr:format}` — applies a .NET format specifier when the value is `IFormattable`: `"${n:X4}"` → `"00FF"`.
* `${expr,alignment:format}` — both clauses: `"[${n,6:X2}]"` → `"[    FF]"`.
* `$$` — escapes to a literal `$`.

The hole grammar is:

```
Hole       := Expression [ "," Alignment ] [ ":" FormatString ]
Alignment  := [ "-" ] DecimalDigits      -- constant; '-' left-justifies (C# parity)
```

The `,`/`:` separators are recognized only at the top level of the hole (a `,`/`:` nested inside `()`, `[]`, or `{}`, or inside a string/char literal, is part of the expression).

Binding and lowering are unified through a dedicated `BoundInterpolatedStringExpression` node that preserves each literal/hole part with its alignment/format intent (ADR-0055). Lowering is *late* and chosen by context:

* Default — formatting defaults to the current culture. The tree-walk interpreter renders the node directly via composite formatting; compiled code lowers it to the .NET `DefaultInterpolatedStringHandler` pattern, so value-type holes are appended without boxing (issue #368).
* The contextual target type is `System.IFormattable` or `System.FormattableString` → `FormattableStringFactory.Create(format, args)` (ADR-0055 Tier 4, #369). Formatting is **deferred**: the caller chooses the culture via `ToString(IFormatProvider)`, e.g. `fs.ToString(CultureInfo.InvariantCulture)`. The default culture is `CultureInfo.CurrentCulture`.

A *contextual target type* is supplied by a typed `let` declaration, a function return whose declared type is `IFormattable`/`FormattableString`, an explicit conversion (cast), or a **call argument** whose parameter type is one of those (functions, methods, constructors, and imported CLR overloads). In an overloaded call the interpolation keeps its natural `string` type for applicability, so a `string` overload is still preferred over a `FormattableString` overload (C# parity); the interpolation is re-lowered to `FormattableStringFactory.Create` only once a `FormattableString`/`IFormattable` parameter is actually chosen.

## Comments

Single-line comments start with `//` and run to the end of the line. (Block-comment syntax is not yet implemented; see the execution plan.)

## Annotation lead-ins

A leading `@` (the `AtToken`) introduces a Kotlin-style annotation per ADR-0047: `@Foo`, `@Foo("msg")`, `@Foo("msg", true)`, or `@target:Foo`. The `@` is a punctuation token used only by the annotation parser; it has no other syntactic role in expressions. The annotation list itself is part of the declaration grammar — see `docs/adr/0047-attribute-syntax-and-declaration.md`.

## Whitespace and line terminators

Spaces, tabs, and line terminators are insignificant outside of string literals.

## See also

* `docs/coverage-matrix.md` — language-construct coverage matrix.
* `docs/adr/0011-string-interpolation-grammar.md` — interpolation sub-grammar and lowering (superseded by ADR-0055).
* `docs/adr/0055-string-interpolation-revamp.md` — current interpolation grammar, alignment/format, tiered/culture-correct lowering (incl. `FormattableString`), and `DefaultInterpolatedStringHandler` lowering.
* `docs/adr/0012-raw-string-delimiter.md` — rationale for backtick raw strings.
* `docs/adr/0044-numeric-primitive-coverage.md` — primitive-type lattice and numeric suffix grammar.
* `docs/adr/0045-object-universal-upper-bound.md` — `object` as the universal upper bound.
* `docs/adr/0046-char-literal-grammar.md` — `char` literals and escape grammar.
* `docs/adr/0047-attribute-syntax-and-declaration.md` — Kotlin-style attribute syntax (`@Foo(...)`) and `@Attribute` declaration sugar.
