# ADR-0140: `shared { init { … } }` static-initializer block

- **Status**: Accepted
- **Date**: 2026-07-05
- **Phase**: Phase 3
- **Related**: ADR-0053 (`shared { }` static members), ADR-0115 §B.11 (cs2gs member mapping), ADR-0031 (`for … in`), issues [#2131](https://github.com/DavidObando/gsharp/issues/2131), [#914](https://github.com/DavidObando/gsharp/issues/914)

## Context

A `shared { }` block (ADR-0053) groups a type's static members: fields (with
optional initializers), properties, events, and methods. What it could **not**
express was the body of a C# **static constructor** — arbitrary
type-initialization logic that runs once, before first access to any static
member or first instance creation.

The canonical motivating case is a computed lookup table (Oahu.Core's
`Cryptography/Crc32.cs`):

```csharp
internal static class Crc32 {
  private const uint Polynomial = 3988292384;
  private static readonly uint[] Table = new uint[256];
  static Crc32() {                       // <-- static ctor body: no G# surface
    for (uint i = 0; i < Table.Length; ++i) { /* fill Table[i] */ }
  }
}
```

A per-field initializer expression cannot fill a 256-entry table with
index-dependent, loop-computed values, and there was no other place to run
statements in a static context. cs2gs therefore had no faithful target for a C#
static constructor body (ADR-0115 §B.11 gap).

## Decision

Add an `init { <statements> }` block usable **inside** a `shared { }` block:

```gsharp
class Crc32 {
    shared {
        private const Polynomial uint32 = 3988292384
        private let Table []uint32 = [256]uint32
        init {
            for i in 0 ... 256 {
                var value uint32 = 0
                var temp uint32 = uint32(i)
                for j in 0 ... 8 {
                    if ((value ^ temp) & 0x1) != 0 {
                        value = (value >> 1) ^ Polynomial
                    } else {
                        value = value >> 1
                    }
                    temp = temp >> 1
                }
                Table[i] = value
            }
        }
    }
}
```

Semantics — matching a C# static constructor exactly:

1. **`init` is contextual.** It is only special as the first token of a
   `shared`-block member, immediately followed by `{`. It is not a reserved
   keyword, so existing uses of `init` (the constructor form `init(...)` and the
   `init` property accessor) are unaffected.
2. **Emission into `.cctor`.** The block's statements are bound in a static
   context whose owner is the enclosing type (so bare static-field / static-
   property names resolve and are **assignable**, exactly like a `shared`
   method body), lowered, and emitted into the type's static constructor
   (`.cctor`) **after** the static-field initializers, in source order.
3. **Run-once, lazy.** Ordinary CLR `.cctor` semantics apply: the body runs
   exactly once, before first access to any static member or first instance
   creation.
4. **Not `beforefieldinit`.** A type with an `init` block carries an explicit
   type-initializer body, so — as C# does when a static constructor is declared
   — the emitter **clears** `beforefieldinit` on that type. Field-initializer-
   only types keep `beforefieldinit`.
5. **Multiple blocks.** More than one `init { }` block is permitted; the blocks
   are concatenated in source order and lowered together, so generated labels
   stay unique and ordering-sensitive side effects are preserved.

## Consequences

- Positive: G# can now express arbitrary static-initialization logic —
  computed tables, interdependent static state, ordering-sensitive side effects
  — with the same guarantees as a C# static constructor. cs2gs gains a faithful
  target for a C# static constructor body (closes the ADR-0115 §B.11 gap).
- Positive: no new reserved word; `init` stays a contextual identifier.
- Neutral: dropping `beforefieldinit` slightly changes when the `.cctor` runs
  (deterministically before first access rather than at an unspecified earlier
  point) — this is exactly the C# static-constructor guarantee callers expect.
- Negative: the block runs on the type-initialization path, so an exception it
  throws surfaces as a `TypeInitializationException`, identical to C#.

## Alternatives considered

- **Reuse a synthesized static method the user calls explicitly.** Rejected: it
  loses the run-once, run-before-first-access guarantee and is not what a C#
  static constructor does.
- **Make `init` a reserved keyword.** Rejected: it would collide with the
  existing constructor `init(...)` and `init` property-accessor surface. A
  contextual token (first member token followed by `{`) is unambiguous.
- **Extend field initializers to accept a statement block.** Rejected: a field
  initializer is a single expression bound with no `this`/statement context;
  overloading it with statements would blur two distinct concepts. A dedicated
  block is clearer and maps 1:1 to the C# static-ctor body.
