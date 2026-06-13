# ADR-0049: Width-bearing integer keyword names

- **Status**: Accepted (Note: the "no alias" subset of this decision is superseded by [ADR-0098](0098-friendly-numeric-type-aliases.md), which re-introduces the C#-style names as binder-resolved aliases on top of the canonical width-bearing names. The canonical-name decision and rename of `int` → `int32` etc. stand unchanged.)
- **Date**: 2026-05-28
- **Phase**: Phase 8 — numeric cleanup
- **Related**: ADR-0044 (numeric primitive coverage), issue #201

## Context

ADR-0044 established the full primitive keyword table. It made an explicit asymmetry:

- Floating-point types carry their width: **`float32`**, **`float64`**.
- Integer types use C#-style names without explicit width: `byte`, `sbyte`, `short`, `ushort`, `int`, `uint`, `long`, `ulong`.

The rationale given in ADR-0044 was backward compatibility with the existing `int` keyword and natural reading of imported BCL signatures. However, the asymmetry is jarring — `float32` announces its width, but `long` hides it — and it conflicts with GSharp's broader Go aesthetic (`:=`, slices, channels, `func`). Since GSharp has not yet shipped a stable release, this is the lowest-cost moment to eliminate the inconsistency.

### Comparison of naming conventions

| CLR type        | Go name   | C# name  | GSharp (ADR-0044) |
| --------------- | --------- | -------- | ------------------|
| `System.SByte`  | `int8`    | `sbyte`  | `sbyte`           |
| `System.Byte`   | `uint8`   | `byte`   | `byte`            |
| `System.Int16`  | `int16`   | `short`  | `short`           |
| `System.UInt16` | `uint16`  | `ushort` | `ushort`          |
| `System.Int32`  | `int32`   | `int`    | `int`             |
| `System.UInt32` | `uint32`  | `uint`   | `uint`            |
| `System.Int64`  | `int64`   | `long`   | `long`            |
| `System.UInt64` | `uint64`  | `ulong`  | `ulong`           |
| `System.Single` | `float32` | `float`  | `float32` ✓       |
| `System.Double` | `float64` | `double` | `float64` ✓       |

Go separates the fixed-width integer names from the platform-native `int`/`uint` (which are at least 32 bits but may be 64). GSharp's existing `int` maps to `System.Int32` — a *fixed* 32-bit integer — so it is closer in semantics to Go's `int32` than to Go's `int`. GSharp already provides `nint`/`nuint` for the native-width case, making Go's ambiguous `int` unnecessary.

## Decision

Replace all C#-style fixed-width integer keywords with Go-style width-bearing names.

### Updated keyword table (integers only)

| Keyword   | CLR type           | Replaces   |
| --------- | ------------------ | ---------- |
| `int8`    | `System.SByte`     | `sbyte`    |
| `uint8`   | `System.Byte`      | `byte`     |
| `int16`   | `System.Int16`     | `short`    |
| `uint16`  | `System.UInt16`    | `ushort`   |
| `int32`   | `System.Int32`     | `int`      |
| `uint32`  | `System.UInt32`    | `uint`     |
| `int64`   | `System.Int64`     | `long`     |
| `uint64`  | `System.UInt64`    | `ulong`    |

All other primitives are unchanged: `bool`, `char`, `string`, `object`, `decimal`, `float32`, `float64`, `nint`, `nuint`, `void`.

### `int` keyword removal

`int` is removed as a standalone keyword. Code that previously wrote `int` must now write `int32`. There is **no alias** — two spellings for the same type violate the GSharp design tenet of a single canonical surface. Automated migration of existing `.gs` files is straightforward (`s/\bint\b/int32/g` with minor exclusions for identifiers).

Downstream effects:

- Literal inference default for unconstrained integer literals remains `int32` (the CLR's default for most arithmetic), now spelled that way in diagnostics and `typeof`/`nameof` output.
- Explicit suffix `L` produces `int64`; `U` produces `uint32`; `UL`/`LU` produce `uint64`. The suffix table in ADR-0044 is otherwise unchanged (suffixes refer to *types*, not spellings).
- The signed-beats-unsigned tie-breaker in ADR-0037 continues to apply to the same CLR types under their new names.

### Implementation scope

1. **`TypeSymbol.cs`** — rename static members and their `name` strings.
2. **`SyntaxFacts.cs` / `Lexer.cs`** — remove old keywords, add new ones.
3. **`SyntaxKind.cs`** — rename `*Keyword` enum members if any; add new ones.
4. **Binder / Conversion** — update all name-referenced lookups.
5. **Tests** — update all `InlineData` strings and golden files from old to new names.
6. **Samples** — global rename throughout `.gs` source files.
7. **Error messages and diagnostics** — type names printed in messages now use the new spelling.

## Consequences

- **Positive**: Full visual consistency — every fixed-width type spells out its width (`int32`, `float32`, etc.). Newcomers from Go, Rust, or C++ will immediately recognise the naming pattern.
- **Positive**: Removes the ambiguity that `int` was 32-bit fixed-width in GSharp but native-width in Go; GSharp's `int32` is unambiguous.
- **Positive**: `typeof(int32)` and `nameof` outputs match the keyword exactly, removing the CLR-name/keyword mismatch that existed for `long`→`Int64`, etc.
- **Negative**: Breaking change for all existing `.gs` source. Mitigated by the early stage of the language and the mechanical nature of the migration.
- **Negative**: BCL interop signatures printed in diagnostics (e.g., `Console.WriteLine(int32)`) now use GSharp spellings, not C# spellings — callers familiar with C# docs need to map mentally. This cost is accepted as consistent with how `float64` already diverges from C#'s `double`.
- **Neutral**: The literal suffix table and overload tie-breaking rules are unchanged in semantics.

## Alternatives considered

- **Status quo (rejected).** Keep C#-style integer names, accept the float/int asymmetry. Rejected because the asymmetry is confusing and the cost of deferral grows as more code is written.
- **Introduce width aliases alongside C#-style names (rejected).** Allow both `int` and `int32` to name the same type. Rejected because dual spellings complicate error messages, IDE display, and the mental model. GSharp deliberately does not have `double`/`float64` duality.
- **Adopt Go's native-width `int` / `uint` semantics (rejected).** Make `int` platform-native (like Go's `int`) instead of fixed-width `Int32`. Rejected because GSharp already added `nint`/`nuint` for the native-width role, and redefining `int` would silently change the size of every existing `int` variable on 64-bit platforms — a much more dangerous breakage than a simple rename.
- **Rename only the less-common types, keep `int` (rejected).** E.g., rename `long` → `int64` but keep `int`. Rejected because a partial rename leaves the asymmetry intact and is less discoverable; once `long` becomes `int64`, readers expect `int` to be `int32` by analogy and are confused when it is not.
