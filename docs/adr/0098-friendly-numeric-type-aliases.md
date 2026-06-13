# ADR-0098: Friendly numeric type aliases (`int`, `long`, `byte`, `float`, …)

- **Status**: Accepted
- **Date**: 2026-06-13
- **Phase**: Phase 8 — naming polish
- **Closes**: Issue #729 (Add friendly numeric type aliases (`int`, `long`, `byte`, `float`, …))
- **Related**: ADR-0044 (numeric primitive coverage); ADR-0049 (width-bearing integer keyword names — _superseded for the alias-vs-rename decision_); ADR-0037 (numeric tie-breaking); parent issue #706 (G# Language — Current State and Design Opportunities, §6.7 Deferred)

## Context

ADR-0049 (May 2026) replaced every C#-style integer keyword with a Go-style
width-bearing name (`int8`, `int16`, `int32`, `int64`, `uint8`, …) so the
width is always visible in source and the float/int asymmetry that ADR-0044
had left in place (`float32` next to `int`) was eliminated. That ADR
explicitly **rejected** introducing aliases alongside the canonical names —
"dual spellings complicate error messages, IDE display, and the mental
model" — and removed the `int` keyword outright.

Six months of operating under the width-bearing-only rule has produced
consistent feedback (issue #729, parent issue #706 §6.7):

- `int32` is the right *canonical* name but the wrong *every-day* name.
  Local variables, lambda parameters, range bounds, and tiny helper
  functions all read more cleanly when the type is one syllable.
- Every comparison language (C#, Go, Kotlin, Swift, Rust's `i32`/`u32` mod
  the prefix) ships a friendly shortcut. Width-bearing names alone are a
  pedagogical asset and an ergonomic liability — readers want both.
- Imports from the BCL routinely show C# spellings in docs and signatures
  (`Console.WriteLine(int value)`, `Encoding.UTF8.GetByteCount(string)`),
  so refugees from C# and Kotlin reach for `int`/`byte` first.
- The "two spellings complicate diagnostics" concern from ADR-0049 is
  defused if the alias resolves to the canonical TypeSymbol at the
  binding layer: diagnostics, `typeof`, `nameof`, hover, and IL all use
  the canonical name regardless of which spelling was written.

This ADR introduces a strict superset on top of the width-bearing names
without re-opening the float/int asymmetry, without renaming any existing
type, and without changing the IL that reaches the emitter.

## Decision

Add ten friendly numeric type aliases. The width-bearing names remain
canonical and are the only spelling that appears in diagnostics, `typeof`,
`nameof`, debugger displays, IL, and reflection-based round-trips.

### Alias table

| Alias    | Canonical | CLR type           |
| -------- | --------- | ------------------ |
| `int`    | `int32`   | `System.Int32`     |
| `uint`   | `uint32`  | `System.UInt32`    |
| `long`   | `int64`   | `System.Int64`     |
| `ulong`  | `uint64`  | `System.UInt64`    |
| `short`  | `int16`   | `System.Int16`     |
| `ushort` | `uint16`  | `System.UInt16`    |
| `byte`   | `uint8`   | `System.Byte`      |
| `sbyte`  | `int8`    | `System.SByte`     |
| `float`  | `float32` | `System.Single`    |
| `double` | `float64` | `System.Double`    |

The aliases cover exactly the integer and IEEE-754 primitives. `nint`,
`nuint`, `decimal`, `char`, `string`, `bool`, `object`, and `void` have
**no alias** — they already have the canonical one-word spelling, and
there is no widely-shared shorter form to graft on.

### Resolution

Aliases resolve in `Binder.LookupType` in the same `switch` that already
recognises the canonical names. The resolution produces the canonical
`TypeSymbol` instance (e.g. `TypeSymbol.Int32` for `int`), so:

- Two declarations `let a int = 1` and `let b int32 = 1` produce variables
  whose `Type` is reference-identical. No conversion, overload, or
  generic-instantiation logic needs to know aliases exist.
- The bound tree, the emitter, the IL verifier, and reflection all see
  the canonical name. There is no `BoundNodeKind` change and no new IL.
- Diagnostics and `typeof` / `nameof` print the canonical name, eliminating
  the "two-name display problem" ADR-0049 warned about. Authors can choose
  whichever spelling reads best; the compiler always _talks back_ in the
  canonical name.

### Aliases are reserved type names (not lexer keywords, but not shadowable)

The aliases are **not** lexer keywords — they remain ordinary identifiers
in the token stream, exactly like the canonical width-bearing names. They
are also not allowed to be shadowed by user-defined type declarations:
`Binder.IsPrimitiveTypeName` accepts the alias spellings, so

```gsharp
type int = string         // diagnostic GS0102: 'int' is already declared.
struct byte { ... }       // diagnostic GS0102: 'byte' is already declared.
```

are rejected with the same diagnostic that already protects `int32` and
`uint8`. This is the simpler of the two design alternatives the issue
posed ("aliases are NOT keywords (defer to identifier resolution) — or DO
make them keywords"); treating aliases as reserved type names matches
user expectations from C#, Kotlin, Go, and Swift, and gives the alias
table a single, unambiguous meaning everywhere.

Variable, parameter, field, and member identifiers are still free to use
these spellings — the alias names live in the *type* namespace, not the
expression namespace. `var int = 5` continues to declare a local named
`int`; `func long(x int) int { … }` continues to declare a function named
`long`. Only the `type` / `struct` / `class` / `enum` / `delegate`
declaration positions reject these names.

### Implementation scope

1. `src/Core/CodeAnalysis/Binding/Binder.cs`:
   1. `LookupType` — add ten alias `case` labels that fall through to the
      corresponding canonical `TypeSymbol`.
   2. `IsPrimitiveTypeName` — add the ten aliases so user-defined type
      declarations using these names fail with `GS0102` (already-declared).
2. `test/Core.Tests/CodeAnalysis/Binding/Issue729FriendlyNumericAliasBinderTests.cs`:
   pin reference-identity to the canonical `TypeSymbol` in every type-clause
   position (variable, parameter, return, generic argument, array
   element), the diagnostic-stability promise (canonical names continue
   to bind clean), interoperability of alias and canonical declarations
   at call sites, and the GS0102 shadowing-rejection for each alias.
3. `test/Compiler.Tests/Emit/Issue729FriendlyNumericAliasEmitTests.cs`:
   compile-verify-and-run programs written in aliases _and_ in canonical
   names for each alias, and assert byte-identical method-body IL.
4. `test/Interpreter.Tests/Issue729FriendlyNumericAliasInterpreterTests.cs`:
   REPL-execution parity between aliases and canonical names.
5. `samples/FriendlyNumericAliases.gs` + `.golden`: a small mixed-alias /
   canonical-name sample so the alias table appears in the conformance
   sample suite and the docs site has runnable copy.
6. `docs/adr/0098-friendly-numeric-type-aliases.md` (this file).
7. Website updates:
   - `website/docs/ref/spec.md` §6 (built-in types): record the alias
     table; canonical names remain the normative spelling.
   - `website/docs/guide/types-and-values.md`: brief note that aliases
     are accepted.
   - `website/docs/guide/lexical-structure.md`: link to this ADR alongside
     ADR-0049 in the numeric-design references.
   - `website/docs/guide/effective-gsharp.md`: "Names and visibility" /
     "Naming numeric types" stance — see *Style guide* below.
   - `website/docs/tour/types.md`: a one-line mention that `int` / `byte`
     are accepted spellings of `int32` / `uint8`.
   - `website/docs/ref/feature-matrix.md`: update the "Width-bearing
      integer names" row.
   - `website/docs/design-decisions.md`: index entry for ADR-0098.
   - `website/docs/bridges/gsharp-for-csharp-developers.md` and
      `gsharp-for-go-developers.md`: refresh the type-mapping callouts.
   - `website/docs/faq.md`: refresh the "why width-bearing names" answer
      to note the alias addition.

No `BoundNodeKind`, `SyntaxKind`, `Lexer`, or `BoundBinaryOperator` /
`BoundUnaryOperator` change. The coverage-matrix golden therefore does
not drift.

### Style guide

> **Canonical spellings (`int32`, `uint64`, `float64`, …) are preferred
> in documentation, public library APIs, and conformance samples.
> Friendly aliases (`int`, `byte`, `float`, …) are accepted everywhere a
> type name is accepted and are appropriate inside function bodies,
> lambdas, and local examples where brevity helps reading.**

Rationale: docs and library signatures benefit from the explicit width;
local code benefits from brevity. Pinning the canonical name in public
API shape keeps cross-library readability stable as a project grows. The
formatter does **not** rewrite either spelling — author intent wins.

## Consequences

- **Positive — ergonomics.** The most common type names regain their
  one-word spellings; refugees from C#, Kotlin, Go, and Swift do not need
  to translate every `int` to `int32` as they read or write code.
- **Positive — pedagogy preserved.** Canonical names remain the only
  spelling that appears in diagnostics, `typeof`, `nameof`, hover, and
  IL. New readers learning the language through error messages and
  generated docs see the explicit-width names first.
- **Positive — zero emit risk.** Aliases erase to the canonical
  `TypeSymbol` in `LookupType`; the bound tree, the emitter, the IL
  verifier, and reflection are untouched. The emit-equivalence
  CompileAndRun tests assert byte-identical method bodies.
- **Positive — diagnostic stability.** Existing code that uses
  canonical names bind unchanged. There are no new diagnostics on
  primitive-type identifiers; the only new rejection (`type int = …`)
  fires only on previously-undefined inputs.
- **Negative — "two ways to say it" returns.** ADR-0049's deliberate
  one-name rule is softened. The style guide and canonical-name
  formatting policy bound the cost: docs, error messages, hover, and
  signatures continue to print the width-bearing spelling.
- **Neutral — `int` no longer means "platform-native int".** Some
  newcomers from Go (`int` is at least 32 bits, may be 64) will need to
  learn that G#'s `int` is fixed `int32`. `nint` / `nuint` continue to
  fill the native-width role. ADR-0049 already debated and rejected the
  alternative; this ADR does not revisit it.

## Alternatives considered

- **Status quo — width-bearing names only (rejected).** Keeps ADR-0049's
  one-name rule. Rejected because the ergonomic cost has compounded and
  the pedagogical concern is fully addressed by displaying the canonical
  name in diagnostics regardless of which spelling was written.
- **Make aliases lexer keywords (rejected).** Re-introduce `int` /
  `byte` / `float` / … as `SyntaxKind.*Keyword` tokens. Rejected because
  `int32` and `float32` are already plain identifiers resolved at the
  binder layer, and matching them to *identifier-form* canonical names
  keeps the surface uniform. Lexer keywords would needlessly add 10
  enum members, sample-grammar updates, and special-case parser logic.
- **Aliases defer to identifier resolution when shadowed (rejected).**
  Allow `type int = string` to win locally so the alias does not steal
  the identifier from user code. Rejected because canonical names like
  `int32` already cannot be shadowed (GS0102); aliases must follow the
  same rule for the alias-vs-canonical equivalence to be airtight.
- **Re-rename canonical names back to C# style (rejected).** Reverse
  ADR-0049 entirely. Rejected because the pedagogical and pattern-
  consistency arguments for `float32` / `float64` apply equally to
  `int32` / `int64`; aliases capture the ergonomic win without
  re-opening the asymmetry.
- **Add only `int` and `float` (rejected).** Cherry-pick the two most
  common aliases and leave the rest. Rejected because a partial table is
  surprising — readers expect symmetry — and the implementation cost of
  the remaining eight is zero (ten `case` labels in two switches).
- **Adopt Rust's `i32` / `u32` instead (rejected).** A different
  alternative-shortcut family. Rejected because it does not solve the
  refugee-friendliness goal that motivated the issue (no comparison
  language outside Rust uses `i32`); the width-bearing canonical name
  already plays that role.
