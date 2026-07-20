// <copyright file="Evaluator.Operators.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Emit = GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Issue #1361 partial of <see cref="Evaluator"/>: unary/binary operator evaluation and the numeric arithmetic, bitwise, shift, comparison, and narrowing helpers.
/// See <c>Evaluator.cs</c> for the root partial (fields, constructor,
/// execution-state accessors, frame management, and the nested state types).
/// </summary>
#pragma warning disable CA1001 // Types that own disposable fields should be disposable
public sealed partial class Evaluator
#pragma warning restore CA1001
{
    private object EvaluateUnaryExpression(BoundUnaryExpression u)
    {
        var operand = EvaluateExpression(u.Operand);

        // Issue #2544: lifted unary operators propagate an empty Nullable<T>.
        // Present nullable values are boxed as T and continue through the
        // existing underlying operation below.
        if (operand == null
            && u.Operand.Type is NullableTypeSymbol
            && u.Type is NullableTypeSymbol)
        {
            return null;
        }

        // Issue #615: unwrap enum operands to underlying before arithmetic/bitwise.
        var rawOperand = UnwrapEnumToUnderlying(operand);

        object result;
        switch (u.Op.Kind)
        {
            case BoundUnaryOperatorKind.Identity:
                result = rawOperand;
                break;
            case BoundUnaryOperatorKind.Negation:
                // Issue #2023: mirror #1881's checked binary Add/Sub/Mul —
                // Negate/NegateChecked both promote sub-int32 operands to int
                // (matching NumericAdd/Sub/Mul), and NarrowToResultType narrows
                // back to the operator's declared result type, itself
                // overflow-checked when u.IsChecked (e.g. `checked(-sbyte.MinValue)`
                // promotes to 128, which then traps narrowing back to sbyte).
                result = NarrowToResultType(u.IsChecked ? NegateChecked(rawOperand) : Negate(rawOperand), u.Type, u.IsChecked);
                break;
            case BoundUnaryOperatorKind.LogicalNegation:
                return !(bool)operand;
            case BoundUnaryOperatorKind.OnesComplement:
                result = OnesComplement(rawOperand);
                break;
            case BoundUnaryOperatorKind.NullAssertion:
                if (operand == null)
                {
                    throw new EvaluatorException("nil value !!", u);
                }

                return operand;

            // For now we don't support DereferenceOf or ReferenceOf.
            default:
                throw new EvaluatorException($"Unexpected unary operator {u.Op}", u);
        }

        // Issue #615: wrap result back to enum type if the operator's result is enum.
        if (u.Type?.ClrType != null && u.Type.ClrType.IsEnum)
        {
            return Enum.ToObject(u.Type.ClrType, result);
        }

        return result;
    }

    private static object Negate(object v) => v switch
    {
        int i => -i,
        long l => -l,

        // sbyte/short negation promotes to int (matching NumericAdd/Sub/Mul);
        // NarrowToResultType narrows back to the declared sbyte/short result.
        sbyte sb => -sb,
        short sh => -sh,
        nint ni => -ni,
        float f => -f,
        double d => -d,
        decimal dec => -dec,
        _ => throw new InvalidOperationException($"Unsupported negation operand type {v?.GetType()}"),
    };

    // Issue #2023: `checked(-x)` — identical shape to <see cref="Negate"/> but
    // every integral arm runs in a checked context (the `checked(...)` keyword
    // traps int/long/nint MinValue negation directly; sbyte/short still widen
    // to int here with no possible overflow, same as unchecked, but the
    // widened value is later narrowed back by <see cref="NarrowToResultType"/>
    // with isChecked: true, which is where their MinValue case actually traps).
    private static object NegateChecked(object v) => v switch
    {
        int i => (object)checked(-i),
        long l => (object)checked(-l),
        sbyte sb => (object)checked(-sb),
        short sh => (object)checked(-sh),
        nint ni => (object)checked(-ni),
        float f => -f,
        double d => -d,
        decimal dec => -dec,
        _ => throw new InvalidOperationException($"Unsupported negation operand type {v?.GetType()}"),
    };

    private static object OnesComplement(object v) => v switch
    {
        int i => ~i,
        long l => ~l,
        sbyte sb => (sbyte)~sb,
        byte b => (byte)~b,
        short sh => (short)~sh,
        ushort us => (ushort)~us,
        uint ui => ~ui,
        ulong ul => ~ul,
        nint ni => ~ni,
        nuint nu => ~nu,

        // Issue #2227: BitClear (&^) on char operands — complement the RHS
        // before ANDing; kept as char here so NumericAnd's char/char arm
        // (promoting the final AND to int32) fires.
        char ch => (char)~ch,
        _ => throw new InvalidOperationException($"Unsupported ~ operand type {v?.GetType()}"),
    };

    private object EvaluateBinaryExpression(BoundBinaryExpression b)
    {
        // Phase 3.C.3 / ADR-0001: null-coalescing must short-circuit so the
        // right-hand side is only evaluated when the left is nil.
        if (b.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
        {
            var leftValue = EvaluateExpression(b.Left);
            if (leftValue != null)
            {
                // Issue #1239: when the best common type widened the left's
                // underlying numeric type (e.g. `int32? ?? int64` → `int64`),
                // convert the non-null left value to the result type. Reference
                // results are representation-preserving and need no conversion.
                var leftUnderlying = b.Left.Type is NullableTypeSymbol ln ? ln.UnderlyingType : b.Left.Type;
                if (b.Type != leftUnderlying
                    && b.Type?.ClrType is { IsValueType: true } resultClr
                    && IsSupportedNumericClrType(resultClr))
                {
                    return UncheckedNumericConvert(leftValue, resultClr);
                }

                return leftValue;
            }

            return EvaluateExpression(b.Right);
        }

        var left = EvaluateExpression(b.Left);
        var right = EvaluateExpression(b.Right);

        switch (b.Op.Kind)
        {
            case BoundBinaryOperatorKind.Equals:
                return NumericEquals(left, right);
            case BoundBinaryOperatorKind.NotEquals:
                return !NumericEquals(left, right);
            case BoundBinaryOperatorKind.LogicalAnd:
                return (bool)left && (bool)right;
            case BoundBinaryOperatorKind.LogicalOr:
                return (bool)left || (bool)right;
        }

        // String concat / bool short-circuiting flow through the existing
        // typed paths; everything else routes through the primitive-aware
        // helpers below so each numeric type uses its own arithmetic.
        if (b.Op.Kind == BoundBinaryOperatorKind.Sum && b.Type == TypeSymbol.String)
        {
            return (string)left + (string)right;
        }

        if (left is bool lb && right is bool rb)
        {
            return b.Op.Kind switch
            {
                BoundBinaryOperatorKind.BitwiseAnd => lb & rb,
                BoundBinaryOperatorKind.BitwiseOr => lb | rb,
                BoundBinaryOperatorKind.BitwiseXor => lb ^ rb,
                _ => throw new EvaluatorException($"Unexpected binary operator {b.Op}", b),
            };
        }

        return EvaluateNumericBinary(b, left, right);
    }

    private static object EvaluateNumericBinary(BoundBinaryExpression b, object left, object right)
    {
        // Issue #615: enum operands arrive as boxed enum values (e.g. DayOfWeek)
        // which do not match the primitive pattern arms in NumericAdd/Sub/etc.
        // Unwrap to the underlying integral type before arithmetic/comparison.
        left = UnwrapEnumToUnderlying(left);
        right = UnwrapEnumToUnderlying(right);

        // §6.1 lifted nullable: if either operand is null, arithmetic/bitwise
        // yields null and ordering yields false.
        if (left == null || right == null)
        {
            switch (b.Op.Kind)
            {
                case BoundBinaryOperatorKind.Less:
                case BoundBinaryOperatorKind.LessOrEquals:
                case BoundBinaryOperatorKind.Greater:
                case BoundBinaryOperatorKind.GreaterOrEquals:
                    return false;
                default:
                    return null;
            }
        }

        var resultType = b.Type;
        switch (b.Op.Kind)
        {
            case BoundBinaryOperatorKind.Sum:
                // Issue #1881: `checked(...)` traps on overflow (matching the
                // emitter's `add.ovf`/`conv.ovf.*`); the narrowing back to a
                // sub-int32 result type must also be range-checked in that
                // context (e.g. `checked(byte.MaxValue + one)`).
                return NarrowToResultType(b.IsChecked ? NumericAddChecked(left, right) : NumericAdd(left, right), resultType, b.IsChecked);
            case BoundBinaryOperatorKind.Difference:
                return NarrowToResultType(b.IsChecked ? NumericSubChecked(left, right) : NumericSub(left, right), resultType, b.IsChecked);
            case BoundBinaryOperatorKind.Product:
                return NarrowToResultType(b.IsChecked ? NumericMulChecked(left, right) : NumericMul(left, right), resultType, b.IsChecked);
            case BoundBinaryOperatorKind.Quotient:
                return NarrowToResultType(NumericDiv(left, right), resultType);
            case BoundBinaryOperatorKind.Remainder:
                return NarrowToResultType(NumericMod(left, right), resultType);
            case BoundBinaryOperatorKind.BitwiseAnd:
                return NarrowToResultType(NumericAnd(left, right), resultType);
            case BoundBinaryOperatorKind.BitwiseOr:
                return NarrowToResultType(NumericOr(left, right), resultType);
            case BoundBinaryOperatorKind.BitwiseXor:
                return NarrowToResultType(NumericXor(left, right), resultType);
            case BoundBinaryOperatorKind.BitClear:
                return NarrowToResultType(NumericAnd(left, OnesComplement(right)), resultType);
            case BoundBinaryOperatorKind.ShiftLeft:
                return NarrowToResultType(NumericShl(left, (int)right), resultType);
            case BoundBinaryOperatorKind.ShiftRight:
                return NarrowToResultType(NumericShr(left, (int)right), resultType);
            case BoundBinaryOperatorKind.UnsignedShiftRight:
                return NarrowToResultType(NumericShrUnsigned(left, (int)right), resultType);
            case BoundBinaryOperatorKind.Less:
            case BoundBinaryOperatorKind.LessOrEquals:
            case BoundBinaryOperatorKind.Greater:
            case BoundBinaryOperatorKind.GreaterOrEquals:
                // Issue #1712: double/float.CompareTo (used by NumericCompare)
                // sorts NaN as less than every value, but IEEE 754 says every
                // ordered comparison against NaN is false. Guard here the same
                // way the relational-pattern path already does (~line 3416)
                // so operator and pattern semantics can't drift.
                if (IsNaN(left) || IsNaN(right))
                {
                    return false;
                }

                var numCmp = NumericCompare(left, right);
                return b.Op.Kind switch
                {
                    BoundBinaryOperatorKind.Less => numCmp < 0,
                    BoundBinaryOperatorKind.LessOrEquals => numCmp <= 0,
                    BoundBinaryOperatorKind.Greater => numCmp > 0,
                    _ => numCmp >= 0,
                };
            default:
                throw new EvaluatorException($"Unexpected binary operator {b.Op}", b);
        }
    }

    private static object NumericAdd(object l, object r) => l switch
    {
        int li when r is int ri => li + ri,
        long li when r is long ri => li + ri,
        uint li when r is uint ri => li + ri,
        ulong li when r is ulong ri => li + ri,
        sbyte li when r is sbyte ri => li + ri,
        byte li when r is byte ri => li + ri,
        short li when r is short ri => li + ri,
        ushort li when r is ushort ri => li + ri,
        nint li when r is nint ri => li + ri,
        nuint li when r is nuint ri => li + ri,
        float li when r is float ri => li + ri,
        double li when r is double ri => li + ri,
        decimal li when r is decimal ri => li + ri,
        char li when r is char ri => li + ri,
        _ => throw new InvalidOperationException($"Unsupported + on {l?.GetType()} and {r?.GetType()}"),
    };

    // Issue #1881: `checked(a + b)` — identical shape to <see cref="NumericAdd"/>
    // but every integral arm runs in a checked context (the `checked(...)`
    // operator applies lexically to every arithmetic operator nested inside
    // it, including switch-expression arms) so int/long/uint/ulong/nint/nuint
    // trap with <see cref="OverflowException"/> instead of wrapping. Narrower
    // widths (sbyte/byte/short/ushort/char) promote to `int` for the add
    // itself (which cannot overflow at that width) — their overflow check
    // happens when the result narrows back in <see cref="NarrowToResultType"/>.
    // Floating-point and decimal are unaffected by `checked`/`unchecked` in C#
    // (float/double never trap; decimal always does), so their arms are
    // identical to the unchecked version.
    private static object NumericAddChecked(object l, object r) => l switch
    {
        int li when r is int ri => (object)checked(li + ri),
        long li when r is long ri => (object)checked(li + ri),
        uint li when r is uint ri => (object)checked(li + ri),
        ulong li when r is ulong ri => (object)checked(li + ri),
        sbyte li when r is sbyte ri => (object)checked(li + ri),
        byte li when r is byte ri => (object)checked(li + ri),
        short li when r is short ri => (object)checked(li + ri),
        ushort li when r is ushort ri => (object)checked(li + ri),
        nint li when r is nint ri => (object)checked(li + ri),
        nuint li when r is nuint ri => (object)checked(li + ri),
        float li when r is float ri => (object)(li + ri),
        double li when r is double ri => (object)(li + ri),
        decimal li when r is decimal ri => (object)(li + ri),
        char li when r is char ri => (object)checked(li + ri),
        _ => throw new InvalidOperationException($"Unsupported + on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericSub(object l, object r) => l switch
    {
        int li when r is int ri => li - ri,
        long li when r is long ri => li - ri,
        uint li when r is uint ri => li - ri,
        ulong li when r is ulong ri => li - ri,
        sbyte li when r is sbyte ri => li - ri,
        byte li when r is byte ri => li - ri,
        short li when r is short ri => li - ri,
        ushort li when r is ushort ri => li - ri,
        nint li when r is nint ri => li - ri,
        nuint li when r is nuint ri => li - ri,
        float li when r is float ri => li - ri,
        double li when r is double ri => li - ri,
        decimal li when r is decimal ri => li - ri,
        _ => throw new InvalidOperationException($"Unsupported - on {l?.GetType()} and {r?.GetType()}"),
    };

    // Issue #1881: checked counterpart of <see cref="NumericSub"/> — see
    // <see cref="NumericAddChecked"/> for why this mirrors the arm shapes.
    private static object NumericSubChecked(object l, object r) => l switch
    {
        int li when r is int ri => (object)checked(li - ri),
        long li when r is long ri => (object)checked(li - ri),
        uint li when r is uint ri => (object)checked(li - ri),
        ulong li when r is ulong ri => (object)checked(li - ri),
        sbyte li when r is sbyte ri => (object)checked(li - ri),
        byte li when r is byte ri => (object)checked(li - ri),
        short li when r is short ri => (object)checked(li - ri),
        ushort li when r is ushort ri => (object)checked(li - ri),
        nint li when r is nint ri => (object)checked(li - ri),
        nuint li when r is nuint ri => (object)checked(li - ri),
        float li when r is float ri => (object)(li - ri),
        double li when r is double ri => (object)(li - ri),
        decimal li when r is decimal ri => (object)(li - ri),
        _ => throw new InvalidOperationException($"Unsupported - on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericMul(object l, object r) => l switch
    {
        int li when r is int ri => li * ri,
        long li when r is long ri => li * ri,
        uint li when r is uint ri => li * ri,
        ulong li when r is ulong ri => li * ri,
        sbyte li when r is sbyte ri => li * ri,
        byte li when r is byte ri => li * ri,
        short li when r is short ri => li * ri,
        ushort li when r is ushort ri => li * ri,
        nint li when r is nint ri => li * ri,
        nuint li when r is nuint ri => li * ri,
        float li when r is float ri => li * ri,
        double li when r is double ri => li * ri,
        decimal li when r is decimal ri => li * ri,
        _ => throw new InvalidOperationException($"Unsupported * on {l?.GetType()} and {r?.GetType()}"),
    };

    // Issue #1881: checked counterpart of <see cref="NumericMul"/> — see
    // <see cref="NumericAddChecked"/> for why this mirrors the arm shapes.
    private static object NumericMulChecked(object l, object r) => l switch
    {
        int li when r is int ri => (object)checked(li * ri),
        long li when r is long ri => (object)checked(li * ri),
        uint li when r is uint ri => (object)checked(li * ri),
        ulong li when r is ulong ri => (object)checked(li * ri),
        sbyte li when r is sbyte ri => (object)checked(li * ri),
        byte li when r is byte ri => (object)checked(li * ri),
        short li when r is short ri => (object)checked(li * ri),
        ushort li when r is ushort ri => (object)checked(li * ri),
        nint li when r is nint ri => (object)checked(li * ri),
        nuint li when r is nuint ri => (object)checked(li * ri),
        float li when r is float ri => (object)(li * ri),
        double li when r is double ri => (object)(li * ri),
        decimal li when r is decimal ri => (object)(li * ri),
        _ => throw new InvalidOperationException($"Unsupported * on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericDiv(object l, object r) => l switch
    {
        int li when r is int ri => li / ri,
        long li when r is long ri => li / ri,
        uint li when r is uint ri => li / ri,
        ulong li when r is ulong ri => li / ri,
        sbyte li when r is sbyte ri => li / ri,
        byte li when r is byte ri => li / ri,
        short li when r is short ri => li / ri,
        ushort li when r is ushort ri => li / ri,
        nint li when r is nint ri => li / ri,
        nuint li when r is nuint ri => li / ri,
        float li when r is float ri => li / ri,
        double li when r is double ri => li / ri,
        decimal li when r is decimal ri => li / ri,
        _ => throw new InvalidOperationException($"Unsupported / on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericMod(object l, object r) => l switch
    {
        int li when r is int ri => li % ri,
        long li when r is long ri => li % ri,
        uint li when r is uint ri => li % ri,
        ulong li when r is ulong ri => li % ri,
        sbyte li when r is sbyte ri => li % ri,
        byte li when r is byte ri => li % ri,
        short li when r is short ri => li % ri,
        ushort li when r is ushort ri => li % ri,
        nint li when r is nint ri => li % ri,
        nuint li when r is nuint ri => li % ri,
        float li when r is float ri => li % ri,
        double li when r is double ri => li % ri,
        decimal li when r is decimal ri => li % ri,
        _ => throw new InvalidOperationException($"Unsupported % on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericAnd(object l, object r) => l switch
    {
        int li when r is int ri => li & ri,
        long li when r is long ri => li & ri,
        uint li when r is uint ri => li & ri,
        ulong li when r is ulong ri => li & ri,
        sbyte li when r is sbyte ri => li & ri,
        byte li when r is byte ri => li & ri,
        short li when r is short ri => li & ri,
        ushort li when r is ushort ri => li & ri,
        nint li when r is nint ri => li & ri,
        nuint li when r is nuint ri => li & ri,

        // Issue #2227: char operands of `&` promote to int32 (C# §12.4.7).
        char li when r is char ri => (int)li & (int)ri,
        _ => throw new InvalidOperationException($"Unsupported & on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericOr(object l, object r) => l switch
    {
        int li when r is int ri => li | ri,
        long li when r is long ri => li | ri,
        uint li when r is uint ri => li | ri,
        ulong li when r is ulong ri => li | ri,
        sbyte li when r is sbyte ri => li | ri,
        byte li when r is byte ri => li | ri,
        short li when r is short ri => li | ri,
        ushort li when r is ushort ri => li | ri,
        nint li when r is nint ri => li | ri,
        nuint li when r is nuint ri => li | ri,

        // Issue #2227: char operands of `|` promote to int32 (C# §12.4.7).
        char li when r is char ri => (int)li | (int)ri,
        _ => throw new InvalidOperationException($"Unsupported | on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericXor(object l, object r) => l switch
    {
        int li when r is int ri => li ^ ri,
        long li when r is long ri => li ^ ri,
        uint li when r is uint ri => li ^ ri,
        ulong li when r is ulong ri => li ^ ri,
        sbyte li when r is sbyte ri => li ^ ri,
        byte li when r is byte ri => li ^ ri,
        short li when r is short ri => li ^ ri,
        ushort li when r is ushort ri => li ^ ri,
        nint li when r is nint ri => li ^ ri,
        nuint li when r is nuint ri => li ^ ri,

        // Issue #2227: char operands of `^` promote to int32 (C# §12.4.7).
        char li when r is char ri => (int)li ^ (int)ri,
        _ => throw new InvalidOperationException($"Unsupported ^ on {l?.GetType()} and {r?.GetType()}"),
    };

    // Issue #421 (P2-2): Go semantics for shift operations. The C# `<<` and
    // Issue #1232: G# shift semantics match C#/CLR. C#'s `<<`/`>>` operators
    // mask the shift count by the operand's stack width (`& 0x1F` for 32-bit
    // operands — including the sub-i4 types, which C# evaluates as int — and
    // `& 0x3F` for 64-bit operands); native-int operands mask to the runtime
    // pointer width. C#'s own `<<`/`>>` (used below) applies exactly this
    // masking, so the count is shifted directly with no range guard, matching
    // the emitter's bare `shl`/`shr` opcodes. (G# previously followed Go,
    // substituting zero when the count was >= the operand width.)
    private static object NumericShl(object l, int r) => l switch
    {
        int li => li << r,
        long li => li << r,
        uint li => li << r,
        ulong li => li << r,
        sbyte li => li << r,
        byte li => li << r,
        short li => li << r,
        ushort li => li << r,
        nint li => li << r,
        nuint li => li << r,

        // Issue #2227: char operands of `<<` promote to int32 (C# §12.4.7).
        char li => (int)li << r,
        _ => throw new InvalidOperationException($"Unsupported << on {l?.GetType()}"),
    };

    private static object NumericShr(object l, int r) => l switch
    {
        int li => li >> r,
        long li => li >> r,
        uint li => li >> r,
        ulong li => li >> r,
        sbyte li => li >> r,
        byte li => li >> r,
        short li => li >> r,
        ushort li => li >> r,
        nint li => li >> r,
        nuint li => li >> r,

        // Issue #2227: char operands of `>>` promote to int32 (C# §12.4.7).
        // `char` is unsigned so there is no sign-extension distinction —
        // the promoted int32 shift right matches C#'s `>>` on `char`.
        char li => (int)li >> r,
        _ => throw new InvalidOperationException($"Unsupported >> on {l?.GetType()}"),
    };

    // Issue #1880: `>>>` always performs a LOGICAL (zero-fill) shift, emitted
    // as CLR `shr.un`, regardless of the operand's signedness. For signed
    // types this differs from `>>` (which is arithmetic/sign-extending);
    // reinterpret the bit pattern as unsigned before shifting, then convert
    // back to the original signed representation.
    private static object NumericShrUnsigned(object l, int r) => l switch
    {
        int li => unchecked((int)((uint)li >> r)),
        long li => unchecked((long)((ulong)li >> r)),
        uint li => li >> r,
        ulong li => li >> r,
        sbyte li => unchecked((sbyte)((uint)(int)li >> r)),
        byte li => li >> r,
        short li => unchecked((short)((uint)(int)li >> r)),
        ushort li => li >> r,
        nint li => unchecked((nint)((nuint)li >> r)),
        nuint li => li >> r,

        // Issue #2227: char operands of `>>>` promote to int32 (C# §12.4.7);
        // char is already unsigned so no reinterpretation is needed. Signed
        // `>>` and unsigned `>>>` coincide here because char's range (0-65535)
        // never sets bit 31, so the promoted int32 is always non-negative.
        char li => (int)li >> r,
        _ => throw new InvalidOperationException($"Unsupported >>> on {l?.GetType()}"),
    };

    private static int NumericCompare(object l, object r) => l switch
    {
        int li when r is int ri => li.CompareTo(ri),
        long li when r is long ri => li.CompareTo(ri),
        uint li when r is uint ri => li.CompareTo(ri),
        ulong li when r is ulong ri => li.CompareTo(ri),
        sbyte li when r is sbyte ri => li.CompareTo(ri),
        byte li when r is byte ri => li.CompareTo(ri),
        short li when r is short ri => li.CompareTo(ri),
        ushort li when r is ushort ri => li.CompareTo(ri),
        nint li when r is nint ri => li.CompareTo(ri),
        nuint li when r is nuint ri => li.CompareTo(ri),
        float li when r is float ri => li.CompareTo(ri),
        double li when r is double ri => li.CompareTo(ri),
        decimal li when r is decimal ri => li.CompareTo(ri),
        char li when r is char ri => li.CompareTo(ri),
        _ => throw new InvalidOperationException($"Unsupported comparison on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NarrowToResultType(object value, TypeSymbol resultType, bool isChecked = false)
    {
        // C# arithmetic on sub-int types promotes to int. To preserve the
        // operator's declared result type (e.g. byte + byte → byte) we
        // narrow back here. Other widths already match their CLR type.
        // Issue #1881: inside a `checked` context the narrowing back to the
        // sub-int32 result type is itself overflow-checked (matching the
        // emitter's `conv.ovf.*` narrowing conversions).
        if (resultType == TypeSymbol.Int8)
        {
            var i32 = Convert.ToInt32(value);
            return isChecked ? checked((sbyte)i32) : unchecked((sbyte)i32);
        }

        if (resultType == TypeSymbol.UInt8)
        {
            var i32 = Convert.ToInt32(value);
            return isChecked ? checked((byte)i32) : unchecked((byte)i32);
        }

        if (resultType == TypeSymbol.Int16)
        {
            var i32 = Convert.ToInt32(value);
            return isChecked ? checked((short)i32) : unchecked((short)i32);
        }

        if (resultType == TypeSymbol.UInt16)
        {
            var i32 = Convert.ToInt32(value);
            return isChecked ? checked((ushort)i32) : unchecked((ushort)i32);
        }

        if (resultType == TypeSymbol.Char)
        {
            var i32 = Convert.ToInt32(value);
            return isChecked ? checked((char)i32) : unchecked((char)i32);
        }

        // Issue #615: when the result type is an enum, produce a properly-typed
        // boxed enum value via Enum.ToObject. The arithmetic helpers return a
        // raw underlying integer; this converts it back to the declared enum type.
        if (resultType?.ClrType != null && resultType.ClrType.IsEnum)
        {
            return Enum.ToObject(resultType.ClrType, value);
        }

        return value;
    }

    /// <summary>
    /// Issue #615: converts a boxed CLR enum value to its underlying primitive
    /// (e.g. DayOfWeek.Monday → int 1) so that the pattern-matching arms in
    /// NumericAdd/Sub/Compare/OnesComplement etc. can match the value. Non-enum
    /// values pass through unchanged.
    /// </summary>
    private static object UnwrapEnumToUnderlying(object value)
    {
        if (value != null && value.GetType().IsEnum)
        {
            return Convert.ChangeType(value, Enum.GetUnderlyingType(value.GetType()));
        }

        return value;
    }
}
