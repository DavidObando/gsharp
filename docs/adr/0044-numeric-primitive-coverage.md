# ADR-0044: Complete numeric primitive coverage

- **Status**: Accepted
- **Date**: 2026-05-26
- **Phase**: Phase 8 — primitive coverage
- **Related**: issue #142, issue #143 (typeof / nameof), ADR-0001 (null model), ADR-0034 (imported CLR interop), ADR-0037 (numeric tie-breaking)

## Context

GSharp today exposes a strict subset of the CLR's primitive types as keywords:

| Keyword  | CLR type        |
| -------- | --------------- |
| `bool`   | `System.Boolean`|
| `int`    | `System.Int32`  |
| `string` | `System.String` |
| `void`   | `System.Void`   |

A `float64` token is referenced in one Binder helper (`Binder.cs:1192`) but no corresponding `TypeSymbol.Float64` exists. Every other CLR primitive — `byte`, `sbyte`, `short`, `ushort`, `uint`, `long`, `ulong`, `nint`/`nuint`, `decimal`, `char`, `float32`/`float64`, and `object` — can only be reached through fully-qualified BCL names after an `import` (`System.Int64`, `System.Decimal`, …). Imported `Console.WriteLine` overloads, for example, are visible but cannot be called with a literal of the right type because the literal's static type cannot be expressed.

Three sub-decisions need to be locked before the implementation work can be split into reviewable PRs:

1. **Canonical spellings** — Go-style (`int64`, `uint32`, `float64`, …) vs. C#-style (`long`, `uint`, `double`, …). GSharp's existing `int` is already aliased to `Int32` (a C#-style choice), but the lone `float64` reference and the broader Go-flavoured design (slices, channels, `:=`, `func`) tilt the floats toward Go.
2. **Literal type inference** — C#-style (every literal has an intrinsic default type; suffixes widen it) vs. Go-style (untyped constants get their type from the surrounding context).
3. **Native-width integers** — naming for `System.IntPtr` / `System.UIntPtr`.

Locking these here unblocks Phases 1–6 of the issue #142 plan.

## Decision

### Canonical name table

The following keywords are added to the GSharp lexer and `SyntaxFacts` keyword table, each pinned to the CLR type listed:

| Keyword   | CLR type           | Notes |
| --------- | ------------------ | ----- |
| `byte`    | `System.Byte`      | 8-bit unsigned |
| `sbyte`   | `System.SByte`     | 8-bit signed |
| `short`   | `System.Int16`     | 16-bit signed |
| `ushort`  | `System.UInt16`    | 16-bit unsigned |
| `int`     | `System.Int32`     | unchanged |
| `uint`    | `System.UInt32`    | 32-bit unsigned |
| `long`    | `System.Int64`     | 64-bit signed |
| `ulong`   | `System.UInt64`    | 64-bit unsigned |
| `nint`    | `System.IntPtr`    | native-width signed |
| `nuint`   | `System.UIntPtr`   | native-width unsigned |
| `float32` | `System.Single`    | IEEE 754 binary32 |
| `float64` | `System.Double`    | IEEE 754 binary64 |
| `decimal` | `System.Decimal`   | 128-bit base-10 |
| `char`    | `System.Char`      | UTF-16 code unit |
| `object`  | `System.Object`    | universal upper bound (see ADR-0045) |

Choices made:

* **Integers and `object` follow C#**. `int`/`uint`/`long`/`ulong`/`short`/`ushort`/`byte`/`sbyte`/`object` keep the C# spellings already implicit in GSharp's existing `int`. C# parity makes interop with imported BCL types (which are everywhere in GSharp) read naturally — `func write(value object)` matches `Console.WriteLine(object)` exactly.
* **Floats follow Go**. `float32`/`float64` (not `float`/`double`). The width is part of the type name, which is consistent with the rest of the Go-flavoured surface and avoids the C# ambiguity of "what's `float`?". This also locks in the meaning of the `float64` helper that already lives in `Binder.cs:1192`.
* **Native-width integers use `nint`/`nuint`**. These spellings are unambiguous, match modern C#, and are consistent with the existing `int = int32` precedent (a fixed-width name even though it could have been native-sized).

### Literal type inference: Go-style untyped constants

A numeric literal token is **untyped** in the lexer. Its static type is determined by the *target type* at the point of use:

1. **Direct target type available.** If the literal appears in a position with an annotated target (variable declaration, parameter, explicit cast, operand of an assignment to a typed location, single-overload argument position), the literal acquires the target's type — provided the literal's value is representable in that type. Otherwise: `ReportInvalidNumber` (`literal '258' cannot be represented as 'byte'`).
2. **No direct target type.** The literal defaults as follows:
   - Integer literals → `int` (preserving today's behaviour).
   - Floating-point literals (containing `.`, `e`, or `E`) → `float64`.
   - Suffixed literals (see below) → the suffix's type.
3. **Arithmetic between untyped literals** stays untyped: `1 + 2` is an untyped integer until placed in a context. `1 + 1.5` is untyped float64 (the wider category wins among untyped operands). Once one operand becomes typed, the literal acquires that type (range-checked).

This preserves the ergonomics that `let x : long = 1` simply works without `1L` decoration, while keeping today's "unannotated `1` is `int`" default unchanged.

### Optional explicit type-pin suffixes

Suffixes are accepted as an *escape hatch* when the user wants to pin a literal's type without writing a target. They follow C# spellings (case-insensitive):

| Suffix     | Type      |
| ---------- | --------- |
| `L`        | `long`    |
| `UL` / `LU`| `ulong`   |
| `U`        | `uint`    |
| `F`        | `float32` |
| `D`        | `float64` |
| `M`        | `decimal` |

Suffixes are **never required**. They are only relevant when the surrounding context cannot supply a target. When a suffix is present *and* a target is supplied, the two must be type-compatible (the suffix wins; mismatch reports a diagnostic).

`nint`/`nuint`/`short`/`ushort`/`sbyte`/`byte`/`char` have **no dedicated suffix**. Such typings always come from context or an explicit cast.

### Underscores and existing radix prefixes

The current `0x`/`0o`/`0b` prefixes and `_` digit separators (per `docs/lexical.md`) apply unchanged to every integer type. Suffixes appear *after* the digit body and are not preceded by an underscore (`0xFF_L` is invalid; write `0xFFL`).

### Floating-point literal grammar

The lexer learns the standard float forms:

```
float_literal = decimal_digits "." [ decimal_digits ] [ exponent ]
              | "." decimal_digits [ exponent ]
              | decimal_digits exponent
exponent      = ( "e" | "E" ) [ "+" | "-" ] decimal_digits
```

Underscores between digits are allowed everywhere they are allowed in integers. Hex/octal/binary floats are not introduced by this ADR.

## Consequences

* Every CLR primitive that imported BCL APIs already expose becomes spellable in GSharp. `Console.WriteLine(42L)`, `decimal` arithmetic, `byte[]` element types via `nint`-indexed APIs all become first-class.
* The "untyped literal" rule keeps the surface ergonomic: code that writes `let x : long = 0` continues to look natural, and existing tests that rely on `1 + 2` being `int` still pass because that's still the default in unconstrained position.
* The lexer's `value` slot now needs to carry more than `int` — typically `long` for integer literals and `double` for float literals, with `decimal` for `M`-suffixed. `BoundLiteralExpression` consumes that wider value and narrows when the target type is known.
* Suffixes overlap visually with identifiers: `0L` is a long literal, `0Lx` is a syntax error (no valid identifier may immediately follow a number). The lexer's existing "number then identifier" boundary already handles this.
* `nint`/`nuint` literals only come from context; this is the same restriction C# applied originally and has not been a usability problem in practice.
* `char` literals are deferred to ADR-0046; this ADR makes `char` *spellable* and addresses range conversions, but does not introduce `'c'` syntax.

## Alternatives considered

* **C#-style floats (`double`, `float`).** Rejected because (a) the existing `float64` reference in the Binder already points the language at Go-style names, and (b) width-in-the-name reads more honestly than `float` (which in C# is 32-bit, but is ambiguous to readers coming from any other language).
* **C#-style intrinsic literal types with required suffixes.** Rejected because `let x : long = 100` is far more common in GSharp's style than `100L`, and forcing the suffix harms ergonomics for no semantic benefit. The Go rule still allows the suffix as a disambiguator.
* **Go-style integer names (`int32`, `int64`, `uint64`, …) everywhere.** Rejected because it would break the existing `int = Int32` keyword and the assumption baked into call sites that `int` is the canonical 32-bit integer. The compromise — fixed-width *float* names but C# integer/object names — matches the precedent already in the codebase.
* **`nativeint` / `unativeint`.** Rejected as verbose; `nint`/`nuint` is the modern C# spelling and reads consistently with `int`/`uint`.
* **No `object` keyword (force `System.Object`).** Rejected because boxing and the universal upper bound are pervasive enough that requiring an import every time is hostile; see ADR-0045 for the semantic side.
