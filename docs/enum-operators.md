# Enum Operator Rules

G# follows the C# §11.10 enum operator specification. All enum operator rules are centralized in [`EnumOperatorTable`](../src/Core/CodeAnalysis/Binding/EnumOperatorTable.cs) — a single declarative source that the binary binder, unary binder, and emitter all consult.

## Supported operations

| Syntax | Left operand | Right operand | Result type | Category |
|--------|--------------|---------------|-------------|----------|
| `==` `!=` `<` `<=` `>` `>=` | E | E | `bool` | Comparison |
| `\|` `&` `^` | E | E | E | Bitwise |
| `+` | E | U | E | Arithmetic |
| `+` | U | E | E | Arithmetic |
| `-` | E | U | E | Arithmetic |
| `-` | E | E | U | Arithmetic |
| `^` (prefix) | E | — | E | Unary (ones-complement) |

Where **E** is any enum type and **U** is its CLR underlying type (one of `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64`).

## Intentionally excluded

Per C# §11.10 these are **not** valid for enum types and G# correctly rejects them:

- Shift operators (`<<`, `>>`) on enums.
- Unary minus (`-`) on enums.
- Multiplication, division, modulus (`*`, `/`, `%`) on enums.
- Any binary operator between two *different* enum types.
- Any arithmetic between an enum and a non-underlying integral type (e.g., `DayOfWeek + int64` when `DayOfWeek` is int32-backed).

## Nullable lifting (§6.1 composition)

All enum operators automatically compose with G#'s §6.1 lifted-nullable system:

```
var a System.DayOfWeek? = DayOfWeek.Monday
var b int32? = int32(2)
Console.WriteLine(a + b)  // prints "Wednesday"
```

If either operand is `nil`, the result is `nil` (the nullable-no-value representation). The binder handles both homogeneous (`E? op E?`) and heterogeneous (`E? op U?`, `E? op U`) nullable lifts.

## Adding a new enum operator group

To add support for a hypothetical new operator on enums:

1. Add one or more `BinaryRule` entries to the `Rules` dictionary in `EnumOperatorTable.cs`, keyed by the token's `SyntaxKind`.
2. Add corresponding test methods to `EnumOperatorTableTests.cs` (unit) and an emit-level test class.
3. The lifted-nullable arm, the emitter's `IsUnsignedOrChar` check, and IL verification all compose automatically — no additional wiring is needed.
