# ADR-0219: Constant floating-point to integer conversions

- **Status**: Accepted (maintainer approval on November 5, 2026)
- **Date**: 2026-11-05
- **Phase**: .NET 11 support
- **Related**: [#5767](https://github.com/DavidObando/gsharp/issues/5767), [#5765](https://github.com/DavidObando/gsharp/issues/5765), [ADR-0129](0129-numeric-literal-narrowing-widening.md)

## Context

gsc folds constant expressions with `ConstantExpressionEvaluator`. The evaluator builds a `System.Linq.Expressions` tree and compiles it, so the JIT of the runtime that hosts gsc calculates each folded value.

ECMA-335 does not specify the result of an unchecked conversion from a floating-point value that is NaN or out of range to an integer type. The runtimes give different results:

| Conversion | .NET 10 | .NET 11 |
| --- | --- | --- |
| `int8(300.5)` | `44` | `127` |
| `uint16(70000.0)` | `4464` | `65535` |
| `uint8(-1.5)` | `255` | `0` |

.NET 9 saturates conversions to 32-bit and 64-bit integers. .NET 11 also saturates conversions to 8-bit and 16-bit integers and `char`.

Thus, before this decision:

1. The same source compiled to different constants when gsc ran on .NET 10 and on .NET 11. This broke the requirement for the same output from the same input.
2. gsc reported no diagnostic for a constant conversion that is out of range.
3. A folded constant could differ from the same conversion at run time on the target runtime.

C# reports CS0221 for such a constant conversion, unless an `unchecked` context contains it.

The maintainer selected "Error unless unchecked" for #5767.

## Decision

1. A constant `float32` or `float64` value that is NaN or out of range and that converts to `int8`, `uint8`, `int16`, `uint16`, `char`, `int32`, `uint32`, `int64`, or `uint64` is error **GS0635**, unless an explicit `unchecked(...)` expression or `unchecked { }` block is the innermost overflow context. The default context and `checked` report it.
2. A value is in range when its value truncated toward zero is in the range of the target type.
3. gsc folds these conversions with one rule that does not depend on the host runtime:
   - A value in range truncates toward zero.
   - A value out of range saturates at the nearest bound of the type.
   - NaN converts to `0`.

   This is the .NET 11 rule for unchecked run-time conversions, and Kotlin's rule for `Double.toInt()`.
4. A conversion of a value that is not constant is a run-time conversion. GS0635 does not apply, and the result is the result of the target runtime.
5. The rule applies to each conversion of a constant operand, not only to a `const` declaration. `let a = unchecked(int8(300.5))`, an argument, a return value, and a lambda body get `127`, the same value as `const a int8 = unchecked(int8(300.5))`. The emitter emits the folded value and does not emit a conversion opcode. An expression tree contains the folded value as a constant, not `Expression.Convert` of the operand.
6. A conversion to `Nullable<T>` of one of these integer types, such as `cast[int8?](300.5)`, follows the same rule: GS0635 outside `unchecked`, and in `unchecked` the folded `T` value wrapped in `Nullable<T>`.
7. The conversion binder reports GS0635, the evaluator folds a `const` declaration, and the emitter and the expression-tree lowerer fold the other positions. Each uses `ConstantExpressionEvaluator.TryFoldFloatingConstantConversion` or `TryConvertFloatingConstant`, so they use the same range test and the same value.

`nint`, `nuint`, `decimal`, and enum targets are not in this decision. gsc does not fold a floating-point conversion to a native-width integer, and a `decimal` conversion that is out of range is not a constant.

## Consequences

- gsc emits the same constant for the same source on each host runtime.
- Source that compiled before can now report GS0635. Correct the value, or write `unchecked(...)` to accept the saturated value.
- On a target before .NET 11, a constant in `unchecked(...)` can differ from the same conversion of a variable at run time, for example `127` and `44` for `300.5` to `int8`. A constant that GS0635 does not report is in range and has the same value on each runtime.
- Integer to integer constant conversions do not change. `int8(300)` continues to wrap to `44`; its result is the same on each runtime.
