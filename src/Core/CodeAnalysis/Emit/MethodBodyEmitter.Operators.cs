// <copyright file="MethodBodyEmitter.Operators.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class
#pragma warning disable SA1505 // opening brace should not be followed by a blank line — partial classes ship with a leading blank for readability
#pragma warning disable SA1202 // 'internal' members should come before 'private' members

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-11 partial of <see cref="MethodBodyEmitter"/>:
/// unary/binary operators, shift guards, narrowing truncation.
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

    private void EmitUnary(BoundUnaryExpression u)
    {
        // Phase 3.C.3: `!!` is a runtime null-assertion. Emit a check
        // ahead of the operand load so we don't accidentally take a
        // dependency on stack tracking inside the operand.
        if (u.Op.Kind == BoundUnaryOperatorKind.NullAssertion)
        {
            // Issue #504: a value-type `Nullable<T>` operand cannot use
            // `dup; brtrue` (the `Nullable<T>` struct on the stack has no
            // valid `brtrue` interpretation — it produces invalid IL).
            // Instead, spill the struct to a pre-allocated `Nullable<T>`
            // slot, take its address, and call `Nullable<T>::get_Value()`,
            // which returns the underlying T or throws
            // `InvalidOperationException` when `HasValue == false`. This
            // matches the BCL `Nullable<T>.Value` property's semantics.
            if (u.Operand.Type is NullableTypeSymbol operandNullable
                && operandNullable.UnderlyingType?.ClrType is { IsValueType: true } innerClr)
            {
                if (!this.receiverSpillSlots.TryGetValue(u, out var unwrapSlot))
                {
                    throw new InvalidOperationException(
                        "No scratch slot pre-allocated for value-type Nullable<T> '!!' operand — "
                        + "check NullableValueTypeUnwrapCollector and the prepass in CollectLocalsAndLabels.");
                }

                this.EmitExpression(u.Operand);
                this.il.StoreLocal(unwrapSlot);
                this.il.LoadLocalAddress(unwrapSlot);
                this.il.OpCode(ILOpCode.Call);
                this.il.Token(this.outer.wellKnown.GetNullableGetValueReference(innerClr));
                return;
            }

            // Issue #831: `!!` on an open-type-parameter operand whose
            // type is bare `T` or `T?` and where T is NOT
            // struct-constrained. The bottom `dup; brtrue` path below
            // is invalid IL — the verifier rejects `dup` / `brtrue`
            // on an opaque `!!T` stack value because it cannot prove T
            // is a reference type at the signature layer. Mirror the
            // value-type spill: store the operand to a `T`-typed slot,
            // probe its non-nullness via `box !!T; brtrue nonNull`,
            // throw on the null path, and reload the slot on the
            // non-null path. The JIT elides the box when T resolves to
            // a reference type at runtime (ECMA-335 III.4.1). This
            // catches both the un-narrowed `self!!` over `self T?` and
            // the smart-cast `self!!` whose binder-typed operand has
            // already collapsed to bare `T` after a null-check guard.
            if (TryGetOpenTypeParameter(u.Operand.Type, out var tpOperand))
            {
                if (!this.receiverSpillSlots.TryGetValue(u, out var tpUnwrapSlot))
                {
                    throw new InvalidOperationException(
                        "No scratch slot pre-allocated for class-constrained `T?` / open `T` '!!' operand — "
                        + "check NullableValueTypeUnwrapCollector and the prepass in CollectLocalsAndLabels.");
                }

                var tpToken = this.outer.GetElementTypeToken(tpOperand);
                var tpNonNull = this.il.DefineLabel();

                this.EmitExpression(u.Operand);
                this.il.StoreLocal(tpUnwrapSlot);
                this.il.LoadLocal(tpUnwrapSlot);
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(tpToken);
                this.il.Branch(ILOpCode.Brtrue, tpNonNull);

                var tpNreCtor = this.outer.wellKnown.GetNullReferenceExceptionCtorRef();
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(tpNreCtor);
                this.il.OpCode(ILOpCode.Throw);

                this.il.MarkLabel(tpNonNull);
                this.il.LoadLocal(tpUnwrapSlot);
                return;
            }

            this.EmitExpression(u.Operand);
            this.il.OpCode(ILOpCode.Dup);
            var nonNull = this.il.DefineLabel();
            this.il.Branch(ILOpCode.Brtrue, nonNull);
            this.il.OpCode(ILOpCode.Pop);
            var nreCtor = this.outer.wellKnown.GetNullReferenceExceptionCtorRef();
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(nreCtor);
            this.il.OpCode(ILOpCode.Throw);
            this.il.MarkLabel(nonNull);
            return;
        }

        this.EmitExpression(u.Operand);
        switch (u.Op.Kind)
        {
            case BoundUnaryOperatorKind.Identity:
                break;
            case BoundUnaryOperatorKind.Negation:
                if (u.Op.OperandType == TypeSymbol.Decimal)
                {
                    var neg = typeof(decimal).GetMethod("op_UnaryNegation", new[] { typeof(decimal) });
                    this.il.Call(this.outer.GetMethodEntityHandle(neg));
                }
                else
                {
                    this.il.OpCode(ILOpCode.Neg);
                }

                break;
            case BoundUnaryOperatorKind.LogicalNegation:
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            case BoundUnaryOperatorKind.OnesComplement:
                this.il.OpCode(ILOpCode.Not);
                break;
            default:
                throw new NotSupportedException(
                    $"Unary operator '{u.Op.Kind}' is not yet supported by the emitter.");
        }

        if (u.Op.Kind == BoundUnaryOperatorKind.OnesComplement
            || u.Op.Kind == BoundUnaryOperatorKind.Negation)
        {
            EmitSubI4Truncation(u.Op.Type);
        }
    }

    private void EmitBinary(BoundBinaryExpression b)
    {
        // Issue #941 / Phase 3.C.3: `??` (NullCoalesce). Short-circuit on the left.
        if (b.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
        {
            // P3-5 / Issue #420: `dup; brtrue` is only legal for object
            // references and primitive integers — it is invalid IL for
            // struct stack values. When the LHS is a value-type
            // `Nullable<T>` (issue #519), spill it to a `Nullable<T>`-
            // typed temp slot and branch on `Nullable<T>::get_HasValue`
            // instead. The non-null branch either reloads the slot
            // (when the result type is `Nullable<T>`) or unwraps via
            // `Nullable<T>::get_Value()` (when the result type is the
            // underlying `T`); both shapes leave a verifiable stack
            // matching the operator's declared result type.
            if (b.Left.Type is NullableTypeSymbol leftNullable
                && leftNullable.UnderlyingType?.ClrType is { IsValueType: true } innerClr)
            {
                if (!this.nullableCoalesceSpillSlots.TryGetValue(b, out var slot))
                {
                    throw new InvalidOperationException(
                        "No scratch slot pre-allocated for value-type Nullable<T> '??' LHS — "
                        + "check NullableValueTypeCoalesceCollector and the prepass in CollectLocalsAndLabels.");
                }

                this.EmitExpression(b.Left);
                this.il.StoreLocal(slot);
                this.il.LoadLocalAddress(slot);
                this.il.OpCode(ILOpCode.Call);
                this.il.Token(this.outer.wellKnown.GetNullableGetHasValueReference(innerClr));
                var fallback = this.il.DefineLabel();
                var end = this.il.DefineLabel();
                this.il.Branch(ILOpCode.Brfalse, fallback);

                // Non-null branch: reproduce the operator's result type.
                if (b.Type is NullableTypeSymbol)
                {
                    // Result is `Nullable<T>` — push the spilled wrapper as
                    // a value. Reloading the slot preserves the present
                    // wrapper (`HasValue == true`) so the consumer sees
                    // the same boxed/wrapped shape it would have observed
                    // had the coalesce been absent.
                    this.il.LoadLocal(slot);
                }
                else
                {
                    // Result is the underlying `T` — call `GetValueOrDefault()`
                    // off the slot's address. `HasValue == true` was just
                    // observed, so the value is present; routing through
                    // `GetValueOrDefault` (Issue #752 / ADR-0084 L3) avoids
                    // the BCL `get_Value` property's redundant HasValue check
                    // and throw path, producing a strictly cheaper IL shape
                    // with no boxing and no callvirt while still leaving the
                    // verifier-clean `T` on the stack.
                    this.il.LoadLocalAddress(slot);
                    this.il.OpCode(ILOpCode.Call);
                    this.il.Token(this.outer.wellKnown.GetNullableGetValueOrDefaultReference(innerClr));

                    // Issue #1239: when the best common type widened the left's
                    // underlying numeric type (e.g. `int32? ?? int64` → `int64`),
                    // convert the unwrapped underlying value to the result type so
                    // the non-null branch leaves a value of `b.Type` on the stack,
                    // matching the (already-converted) right branch.
                    if (b.Type != leftNullable.UnderlyingType)
                    {
                        this.TryEmitNumericConversion(leftNullable.UnderlyingType, b.Type);
                    }
                }

                this.il.Branch(ILOpCode.Br, end);

                // Null branch: evaluate RHS, which the binder typed to
                // match the operator's result (either `T` or `Nullable<T>`).
                this.il.MarkLabel(fallback);
                this.EmitExpression(b.Right);
                this.il.MarkLabel(end);
                return;
            }

            // Issue #831: NullCoalesce over a class-constrained (or
            // unconstrained) `T?` whose underlying is an open type
            // parameter. The underlying T has no static ClrType, so
            // neither the value-type Nullable<T> spill branch above nor
            // the bottom `dup; brtrue` shape is verifiable IL: the
            // verifier rejects `dup` / `brtrue` on an opaque `!!T`
            // stack value because it cannot prove T is a reference type
            // at the signature layer (ECMA-335 III.1.8). Mirror the
            // value-type spill: store the LHS to a `T`-typed slot, probe
            // its non-nullness via `box !!T; brtrue/brfalse` (which the
            // verifier accepts because `box` always produces an object
            // reference), and either reload the slot or evaluate RHS.
            // The JIT elides the box at runtime when T resolves to a
            // reference type (ECMA-335 III.4.1), so the optimized native
            // code is no worse than the original `dup; brtrue` shape.
            if (b.Left.Type is NullableTypeSymbol tpNullable
                && tpNullable.UnderlyingType is TypeParameterSymbol tpUnderlying
                && !tpUnderlying.HasValueTypeConstraint)
            {
                if (!this.nullableCoalesceSpillSlots.TryGetValue(b, out var tpSlot))
                {
                    throw new InvalidOperationException(
                        "No scratch slot pre-allocated for class-constrained `T?` '??' LHS — "
                        + "check NullableValueTypeCoalesceCollector and the prepass in CollectLocalsAndLabels.");
                }

                var tpToken = this.outer.GetElementTypeToken(tpUnderlying);
                var fallback = this.il.DefineLabel();
                var end = this.il.DefineLabel();

                this.EmitExpression(b.Left);
                this.il.StoreLocal(tpSlot);
                this.il.LoadLocal(tpSlot);
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(tpToken);
                this.il.Branch(ILOpCode.Brfalse, fallback);

                this.il.LoadLocal(tpSlot);
                this.il.Branch(ILOpCode.Br, end);

                this.il.MarkLabel(fallback);
                this.EmitExpression(b.Right);
                this.il.MarkLabel(end);
                return;
            }

            // Defensive: any other value-typed LHS (raw struct or enum)
            // remains unsupported by `??`. Today the encoder rejects
            // nullable user-defined structs/enums, so this branch is
            // unreachable from valid source, but fail loudly rather
            // than silently producing PEVerify-rejected IL.
            var leftType = b.Left.Type;
            if (ReflectionMetadataEmitter.IsValueTypeSymbol(leftType))
            {
                throw new NotSupportedException(
                    $"Null-coalesce '??' over value-type operand '{leftType?.Name}' is not yet supported by the emitter. "
                    + "The current `dup; brtrue` short-circuit is invalid IL for struct stack values; a HasValue/Value "
                    + "(or box-before-brtrue) emit path is required when nullable value types are supported.");
            }

            this.EmitExpression(b.Left);
            this.il.OpCode(ILOpCode.Dup);
            var done = this.il.DefineLabel();
            this.il.Branch(ILOpCode.Brtrue, done);
            this.il.OpCode(ILOpCode.Pop);
            this.EmitExpression(b.Right);
            this.il.MarkLabel(done);
            return;
        }

        // PR N-4 / §6.1 / C# §7.3.7: lifted binary operators over a
        // value-type Nullable<T>. The collector pre-allocates LHS / RHS
        // (Nullable<T>) and optional result (Nullable<R>) slots; the
        // emitted IL spills both operands once, branches on their
        // HasValue flags, and then either calls get_Value to compute the
        // underlying op (wrapping the scalar result as a fresh
        // Nullable<R> for arithmetic / bitwise) or yields the relevant
        // bool for equality / ordering. Must precede the bottom of this
        // method, whose `add/clt/...` opcodes would otherwise see two
        // struct values on the stack and produce invalid IL.
        if (this.liftedBinarySlots.TryGetValue(b, out var liftedSlots))
        {
            this.EmitLiftedNullableBinary(b, liftedSlots);
            return;
        }

        // String concatenation / equality go through BCL helpers.
        if (b.Left.Type == TypeSymbol.String && b.Right.Type == TypeSymbol.String)
        {
            switch (b.Op.Kind)
            {
                case BoundBinaryOperatorKind.Sum:
                    this.EmitExpression(b.Left);
                    this.EmitExpression(b.Right);
                    this.il.Call(this.outer.wellKnown.GetStringConcatReference());
                    return;
                case BoundBinaryOperatorKind.Equals:
                    this.EmitExpression(b.Left);
                    this.EmitExpression(b.Right);
                    this.il.Call(this.outer.wellKnown.GetStringEqualsReference());
                    return;
                case BoundBinaryOperatorKind.NotEquals:
                    this.EmitExpression(b.Left);
                    this.EmitExpression(b.Right);
                    this.il.Call(this.outer.wellKnown.GetStringEqualsReference());
                    this.il.LoadConstantI4(0);
                    this.il.OpCode(ILOpCode.Ceq);
                    return;
            }
        }

        // Phase 7.4 / ADR-0033: inline structs compare their single field directly.
        if (b.Left.Type is StructSymbol inlineStruct && inlineStruct.IsInline && b.Right.Type == inlineStruct &&
            (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals))
        {
            var field = inlineStruct.Fields[0];
            var fieldHandle = this.outer.cache.StructFieldDefs[field];
            this.EmitExpression(b.Left);
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);
            if (ReflectionMetadataEmitter.IsValueTypeSymbol(field.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(field.Type));
            }

            this.EmitExpression(b.Right);
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(fieldHandle);
            if (ReflectionMetadataEmitter.IsValueTypeSymbol(field.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(field.Type));
            }

            this.il.Call(field.Type == TypeSymbol.String ? this.outer.wellKnown.GetStringEqualsReference() : this.outer.wellKnown.GetObjectStaticEqualsReference());
            if (b.Op.Kind == BoundBinaryOperatorKind.NotEquals)
            {
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
            }

            return;
        }

        // Phase 3.B.2 / ADR-0029: structural == / != on data-struct
        // values. Box both operands and dispatch through static
        // Object.Equals(object, object) which routes through the
        // virtual ValueType.Equals override.
        if (b.Left.Type is StructSymbol ds && ds.IsData && b.Right.Type == ds &&
            (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals))
        {
            var structTypeDef = this.outer.cache.StructTypeDefs[ds];
            this.EmitExpression(b.Left);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(structTypeDef);
            this.EmitExpression(b.Right);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(structTypeDef);
            this.il.Call(this.outer.wellKnown.GetObjectStaticEqualsReference());
            if (b.Op.Kind == BoundBinaryOperatorKind.NotEquals)
            {
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
            }

            return;
        }

        // Phase 4 emit parity (F1, type-erased generics): `==` / `!=` over
        // open type parameters (e.g. `a == b` in `Eq[T comparable]`). Both
        // operands are erased to System.Object, so a raw `Ceq` would test
        // reference equality and return false for equal boxed value types.
        // Dispatch through static Object.Equals(object, object) — which
        // routes to the boxed value's Equals override — for correct value
        // semantics. ADR-0087 §3 R2+R4: after R2, operands carry their
        // VAR/MVAR type rather than erased object; we must explicitly
        // `box T` each operand before invoking the static Object.Equals
        // overload that takes (object, object). The JIT elides the box
        // when T resolves to a reference type at runtime.
        if (b.Left.Type is TypeParameterSymbol leftTp && b.Right.Type is TypeParameterSymbol rightTp &&
            (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals))
        {
            this.EmitExpression(b.Left);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.GetElementTypeToken(leftTp));
            this.EmitExpression(b.Right);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.GetElementTypeToken(rightTp));
            this.il.Call(this.outer.wellKnown.GetObjectStaticEqualsReference());
            if (b.Op.Kind == BoundBinaryOperatorKind.NotEquals)
            {
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
            }

            return;
        }

        // Issue #831: `T? == nil` / `T? != nil` where the underlying T
        // is an open type parameter (class-constrained, struct-constrained
        // or unconstrained). The concrete value-type Nullable<T> arm above
        // (via liftedBinarySlots + EmitLiftedNullableBinary) only catches
        // operands with a static `ClrType`, which open type parameters do
        // NOT have — so without this guard the bottom of EmitBinary would
        // emit `<T-value>; ldnull; ceq`. ilverify rejects that with
        // `[StackUnexpected]: found Nullobjref ... expected value 'T'`
        // (class/unconstrained) or `expected value 'Nullable`1<T>'`
        // (struct-constrained), because `ceq` cannot match an opaque
        // stack slot against a managed-null reference at the verifier
        // layer. Box the operand first so the comparison runs against an
        // `O` reference. The CLR's `box` opcode has the property that
        // `box Nullable<T>` yields the managed-null reference when
        // HasValue is false (ECMA-335 III.4.1) — so the same shape
        // works uniformly for class-T (boxing a reference is a no-op the
        // JIT elides) and struct-T (boxing a Nullable encodes HasValue
        // into the reference). We use the LHS expression's full type
        // token (the NullableTypeSymbol) so the `box` operand resolves to
        // `!!T` for class/unconstrained-T (where T? stores as a bare
        // reference slot) and to `Nullable<!!T>` for struct-T (where T?
        // stores as a value-typed nullable).
        if ((b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals)
            && TryMatchTypeParameterNilCompare(b, out var tpNilOperand))
        {
            this.EmitExpression(tpNilOperand);
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.GetElementTypeToken(tpNilOperand.Type));
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Ceq);
            if (b.Op.Kind == BoundBinaryOperatorKind.NotEquals)
            {
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
            }

            return;
        }

        // Short-circuit evaluation for logical `&&` and `||`: the right
        // operand must not be evaluated when the left operand already
        // determines the result. Emit a dup + conditional branch so the
        // LHS value is reused as the result without evaluating the RHS.
        if (b.Op.Kind == BoundBinaryOperatorKind.LogicalAnd ||
            b.Op.Kind == BoundBinaryOperatorKind.LogicalOr)
        {
            var endLabel = this.il.DefineLabel();
            this.EmitExpression(b.Left);
            this.il.OpCode(ILOpCode.Dup);
            this.il.Branch(
                b.Op.Kind == BoundBinaryOperatorKind.LogicalAnd ? ILOpCode.Brfalse : ILOpCode.Brtrue,
                endLabel);
            this.il.OpCode(ILOpCode.Pop);
            this.EmitExpression(b.Right);
            this.il.MarkLabel(endLabel);
            return;
        }

        this.EmitExpression(b.Left);
        this.EmitExpression(b.Right);
        if (b.Left.Type == TypeSymbol.Decimal && b.Right.Type == TypeSymbol.Decimal)
        {
            if (this.TryEmitDecimalBinary(b.Op.Kind))
            {
                return;
            }
        }

        bool isUnsigned = IsUnsignedOrChar(b.Left.Type);
        switch (b.Op.Kind)
        {
            case BoundBinaryOperatorKind.Sum:
                this.il.OpCode(ILOpCode.Add);
                break;
            case BoundBinaryOperatorKind.Difference:
                this.il.OpCode(ILOpCode.Sub);
                break;
            case BoundBinaryOperatorKind.Product:
                this.il.OpCode(ILOpCode.Mul);
                break;
            case BoundBinaryOperatorKind.Quotient:
                this.il.OpCode(isUnsigned ? ILOpCode.Div_un : ILOpCode.Div);
                break;
            case BoundBinaryOperatorKind.Remainder:
                this.il.OpCode(isUnsigned ? ILOpCode.Rem_un : ILOpCode.Rem);
                break;
            case BoundBinaryOperatorKind.ShiftLeft:
                this.EmitShiftWithGoSemanticsGuard(ILOpCode.Shl, b.Left.Type);
                break;
            case BoundBinaryOperatorKind.ShiftRight:
                this.EmitShiftWithGoSemanticsGuard(
                    isUnsigned ? ILOpCode.Shr_un : ILOpCode.Shr,
                    b.Left.Type);
                break;
            case BoundBinaryOperatorKind.BitwiseAnd:
                this.il.OpCode(ILOpCode.And);
                break;
            case BoundBinaryOperatorKind.BitwiseOr:
                this.il.OpCode(ILOpCode.Or);
                break;
            case BoundBinaryOperatorKind.BitwiseXor:
                this.il.OpCode(ILOpCode.Xor);
                break;
            case BoundBinaryOperatorKind.BitClear:
                // Go's a &^ b == a & ~b. Right operand is already on top: not, then and.
                this.il.OpCode(ILOpCode.Not);
                this.il.OpCode(ILOpCode.And);
                break;
            case BoundBinaryOperatorKind.Equals:
                this.il.OpCode(ILOpCode.Ceq);
                break;
            case BoundBinaryOperatorKind.NotEquals:
                this.il.OpCode(ILOpCode.Ceq);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            case BoundBinaryOperatorKind.Less:
                this.il.OpCode(isUnsigned ? ILOpCode.Clt_un : ILOpCode.Clt);
                break;
            case BoundBinaryOperatorKind.LessOrEquals:
                this.il.OpCode(isUnsigned ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            case BoundBinaryOperatorKind.Greater:
                this.il.OpCode(isUnsigned ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                break;
            case BoundBinaryOperatorKind.GreaterOrEquals:
                this.il.OpCode(isUnsigned ? ILOpCode.Clt_un : ILOpCode.Clt);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            default:
                throw new NotSupportedException(
                    $"Binary operator '{b.Op.Kind}' is not yet supported by the emitter.");
        }

        EmitNarrowingTruncationIfNeeded(b.Op.Kind, b.Type);
    }

    /// <summary>
    /// Issue #831: matches `T? == nil` / `T? != nil` (and the symmetric
    /// `nil == T?` / `nil != T?`) where the underlying T is an open
    /// type parameter (class-constrained, struct-constrained, or
    /// unconstrained). The concrete value-type Nullable&lt;T&gt; arm
    /// (driven by <see cref="liftedBinarySlots"/>) only catches
    /// operands with a static <c>ClrType</c>; open type parameters
    /// have none, so this match fills the gap. The caller boxes the
    /// matched operand using its full nullable type token, which
    /// resolves to a bare reference slot for class/unconstrained T and
    /// to <c>Nullable&lt;!!T&gt;</c> for struct T.
    /// </summary>
    private static bool TryMatchTypeParameterNilCompare(
        BoundBinaryExpression node,
        out BoundExpression operand)
    {
        if (node.Right.Type == TypeSymbol.Null
            && IsOpenTypeParameterNullable(node.Left.Type))
        {
            operand = node.Left;
            return true;
        }

        if (node.Left.Type == TypeSymbol.Null
            && IsOpenTypeParameterNullable(node.Right.Type))
        {
            operand = node.Right;
            return true;
        }

        operand = null;
        return false;
    }

    /// <summary>
    /// Issue #831: returns true when <paramref name="t"/> is a
    /// <see cref="NullableTypeSymbol"/> wrapping an open type parameter
    /// (regardless of constraint). The CLR storage of <c>T?</c> is
    /// either a bare <c>!!T</c> reference slot (class/unconstrained T)
    /// or a <c>Nullable&lt;!!T&gt;</c> value-typed slot (struct T) —
    /// see <see cref="ReflectionMetadataEmitter.GetElementTypeToken"/>.
    /// Both shapes need the same `box; ldnull; ceq` lowering for
    /// nil-comparison to be verifier-clean: boxing a reference is a
    /// JIT-elided no-op, while boxing <c>Nullable&lt;T&gt;</c> per
    /// ECMA-335 III.4.1 yields a managed-null reference when
    /// HasValue is false.
    /// </summary>
    private static bool IsOpenTypeParameterNullable(TypeSymbol t)
    {
        return t is NullableTypeSymbol nullable
            && nullable.UnderlyingType is TypeParameterSymbol;
    }

    /// <summary>
    /// Issue #831: returns true when <paramref name="t"/> resolves to an
    /// open type parameter that is NOT struct-constrained, either
    /// directly (e.g. after a smart-cast narrowing) or via a
    /// <see cref="NullableTypeSymbol"/> wrapper. Used by the `!!`
    /// (NullAssertion) emit path to recognise both `self T?` and the
    /// narrowed bare-`T` operand shape produced after a preceding
    /// nil-check guard.
    /// </summary>
    private static bool TryGetOpenTypeParameter(TypeSymbol t, out TypeParameterSymbol typeParameter)
    {
        if (t is TypeParameterSymbol bare && !bare.HasValueTypeConstraint)
        {
            typeParameter = bare;
            return true;
        }

        if (t is NullableTypeSymbol nullable
            && nullable.UnderlyingType is TypeParameterSymbol wrapped
            && !wrapped.HasValueTypeConstraint)
        {
            typeParameter = wrapped;
            return true;
        }

        typeParameter = null;
        return false;
    }

    private void EmitNarrowingTruncationIfNeeded(BoundBinaryOperatorKind kind, TypeSymbol resultType)
    {
        // IL evaluation-stack quirk: arithmetic, bitwise, and shift
        // opcodes on sub-i4 operands produce an i4 result that is not
        // truncated to the operand's natural width. For correctness of
        // sbyte/byte/short/ushort/char result types, narrow back.
        //
        // Issue #534: enum types whose underlying CLR type is sub-i4
        // (e.g., a byte-backed [Flags] enum) need the same truncation.
        switch (kind)
        {
            case BoundBinaryOperatorKind.Sum:
            case BoundBinaryOperatorKind.Difference:
            case BoundBinaryOperatorKind.Product:
            case BoundBinaryOperatorKind.Quotient:
            case BoundBinaryOperatorKind.Remainder:
            case BoundBinaryOperatorKind.ShiftLeft:
            case BoundBinaryOperatorKind.ShiftRight:
            case BoundBinaryOperatorKind.BitwiseAnd:
            case BoundBinaryOperatorKind.BitwiseOr:
            case BoundBinaryOperatorKind.BitwiseXor:
            case BoundBinaryOperatorKind.BitClear:
                EmitSubI4Truncation(resultType);
                break;
        }
    }

    /// <summary>
    /// Issue #534: emits a conv.i1 / conv.u1 / conv.i2 / conv.u2
    /// truncation instruction when <paramref name="resultType"/> is a
    /// sub-i4 primitive <em>or</em> a CLR enum whose underlying type is
    /// sub-i4. This keeps the evaluation-stack value in the correct range
    /// after arithmetic, bitwise, or shift opcodes that always produce
    /// an i4 result.
    /// </summary>
    private void EmitSubI4Truncation(TypeSymbol resultType)
    {
        // Fast path: check built-in primitive types first.
        if (resultType == TypeSymbol.Int8)
        {
            this.il.OpCode(ILOpCode.Conv_i1);
        }
        else if (resultType == TypeSymbol.UInt8)
        {
            this.il.OpCode(ILOpCode.Conv_u1);
        }
        else if (resultType == TypeSymbol.Int16)
        {
            this.il.OpCode(ILOpCode.Conv_i2);
        }
        else if (resultType == TypeSymbol.UInt16 || resultType == TypeSymbol.Char)
        {
            this.il.OpCode(ILOpCode.Conv_u2);
        }
        else if (resultType?.ClrType != null && resultType.ClrType.IsEnum)
        {
            // Resolve the enum's underlying integral type and truncate
            // if it is narrower than i4.
            var underlying = System.Enum.GetUnderlyingType(resultType.ClrType);
            var underlyingFull = underlying.FullName;
            if (underlyingFull == "System.SByte")
            {
                this.il.OpCode(ILOpCode.Conv_i1);
            }
            else if (underlyingFull == "System.Byte")
            {
                this.il.OpCode(ILOpCode.Conv_u1);
            }
            else if (underlyingFull == "System.Int16")
            {
                this.il.OpCode(ILOpCode.Conv_i2);
            }
            else if (underlyingFull == "System.UInt16")
            {
                this.il.OpCode(ILOpCode.Conv_u2);
            }
        }
    }

    // Issue #421 (P2-2): IL `shl`/`shr`/`shr_un` mask the shift count to
    // the low log2(stack-width) bits (5 for i4, 6 for i8). G# follows Go
    // semantics, where a shift count >= the operand's natural width
    // yields zero. Without this guard, `int32(1) << 33` would produce 2
    // under the CLR mask but should produce 0 in Go. Emit a runtime
    // check `count >= width` and substitute zero when the count is
    // out-of-range; otherwise emit the normal shift opcode.
    //
    // Stack on entry: [value, count(i4)]; stack on exit: [result].
    // For signed right shift this simplification (zero instead of
    // sign-extension to all-ones for negative values) matches the
    // documented G# behavior — interpreter and emitter agree on it.
    private void EmitShiftWithGoSemanticsGuard(ILOpCode shiftOp, TypeSymbol leftType)
    {
        var zeroLabel = this.il.DefineLabel();
        var endLabel = this.il.DefineLabel();

        this.il.OpCode(ILOpCode.Dup);
        this.EmitTypeBitWidth(leftType);
        this.il.Branch(ILOpCode.Bge_un, zeroLabel);
        this.il.OpCode(shiftOp);
        this.il.Branch(ILOpCode.Br, endLabel);

        this.il.MarkLabel(zeroLabel);
        this.il.OpCode(ILOpCode.Pop);
        this.il.OpCode(ILOpCode.Pop);
        this.EmitZeroForShiftResult(leftType);

        this.il.MarkLabel(endLabel);
    }

    private void EmitTypeBitWidth(TypeSymbol t)
    {
        if (t == TypeSymbol.Int8 || t == TypeSymbol.UInt8)
        {
            this.il.LoadConstantI4(8);
        }
        else if (t == TypeSymbol.Int16 || t == TypeSymbol.UInt16 || t == TypeSymbol.Char)
        {
            this.il.LoadConstantI4(16);
        }
        else if (t == TypeSymbol.Int32 || t == TypeSymbol.UInt32)
        {
            this.il.LoadConstantI4(32);
        }
        else if (t == TypeSymbol.Int64 || t == TypeSymbol.UInt64)
        {
            this.il.LoadConstantI4(64);
        }
        else if (t == TypeSymbol.NInt || t == TypeSymbol.NUInt)
        {
            // Width is sizeof(IntPtr) * 8, determined at IL runtime so
            // 32-bit and 64-bit hosts both produce Go-correct results.
            this.il.OpCode(ILOpCode.Sizeof);
            this.il.Token(this.outer.GetTypeReference(typeof(IntPtr)));
            this.il.LoadConstantI4(8);
            this.il.OpCode(ILOpCode.Mul);
        }
        else
        {
            // Fallback (shouldn't reach here for non-integer types since
            // shifts are only bound on integer operands).
            this.il.LoadConstantI4(32);
        }
    }

    private void EmitZeroForShiftResult(TypeSymbol t)
    {
        if (t == TypeSymbol.Int64 || t == TypeSymbol.UInt64)
        {
            this.il.LoadConstantI8(0);
        }
        else if (t == TypeSymbol.NInt || t == TypeSymbol.NUInt)
        {
            this.il.LoadConstantI4(0);
            this.il.OpCode(ILOpCode.Conv_i);
        }
        else
        {
            this.il.LoadConstantI4(0);
        }
    }

    private bool TryEmitDecimalBinary(BoundBinaryOperatorKind kind)
    {
        string opName = kind switch
        {
            BoundBinaryOperatorKind.Sum => "op_Addition",
            BoundBinaryOperatorKind.Difference => "op_Subtraction",
            BoundBinaryOperatorKind.Product => "op_Multiply",
            BoundBinaryOperatorKind.Quotient => "op_Division",
            BoundBinaryOperatorKind.Remainder => "op_Modulus",
            BoundBinaryOperatorKind.Equals => "op_Equality",
            BoundBinaryOperatorKind.NotEquals => "op_Inequality",
            BoundBinaryOperatorKind.Less => "op_LessThan",
            BoundBinaryOperatorKind.LessOrEquals => "op_LessThanOrEqual",
            BoundBinaryOperatorKind.Greater => "op_GreaterThan",
            BoundBinaryOperatorKind.GreaterOrEquals => "op_GreaterThanOrEqual",
            _ => null,
        };
        if (opName == null)
        {
            return false;
        }

        var op = typeof(decimal).GetMethod(opName, new[] { typeof(decimal), typeof(decimal) });
        if (op == null)
        {
            return false;
        }

        this.il.Call(this.outer.GetMethodEntityHandle(op));
        return true;
    }

    // PR N-4 / §6.1 / C# §7.3.7: emits a lifted binary operator over a
    // value-type Nullable<T>. The pre-allocated slot bundle gives the
    // emitter two Nullable<T>-typed operand slots and, for arithmetic /
    // bitwise operators that produce Nullable<R>, one result slot.
    //
    // The emit shape varies by result type:
    //
    //   * Lifted equality (== / !=) on Nullable<T>:
    //       spill x and y; compare HasValue flags;
    //         - if HasValue differs → false
    //         - if both have no value → true
    //         - otherwise → underlying op (x.Value == y.Value)
    //       Followed by `ldc.i4.0; ceq` for !=.
    //
    //   * Lifted ordering (< <= > >=) on Nullable<T>:
    //       spill x and y; if either lacks value → false;
    //         otherwise → underlying compare on x.Value / y.Value.
    //
    //   * Lifted arithmetic / bitwise on Nullable<T>:
    //       spill x and y; if either lacks value → default(Nullable<R>);
    //         otherwise → newobj Nullable<R>::.ctor(x.Value op y.Value).
    private void EmitLiftedNullableBinary(BoundBinaryExpression b, LiftedBinarySlots slots)
    {
        var leftNullable = (NullableTypeSymbol)b.Left.Type;
        var rightNullable = b.Right.Type == TypeSymbol.Null ? null : (NullableTypeSymbol)b.Right.Type;
        var leftUnderlying = leftNullable.UnderlyingType;
        var leftUnderlyingClr = leftUnderlying.ClrType
            ?? throw new InvalidOperationException(
                $"Lifted binary operator '{b.Op.Kind}' on Nullable<{leftUnderlying.Name}>: underlying has no CLR type.");
        var rightUnderlying = rightNullable?.UnderlyingType;
        var rightUnderlyingClr = rightUnderlying?.ClrType;

        var lhsSlot = slots.LhsSlot;
        var rhsSlot = slots.RhsSlot;

        // Form 2: `x? == nil` / `x? != nil`. The IsNullCompare arm binds
        // this with right-operand type Null; the slot bundle has no RHS
        // and no result slot. Spill the LHS once and consult HasValue.
        // For `== nil` the result is `!HasValue`; for `!= nil` it is
        // `HasValue`.
        if (b.Right.Type == TypeSymbol.Null)
        {
            var getHasValue = this.outer.wellKnown.GetNullableGetHasValueReference(leftUnderlyingClr);

            this.EmitExpression(b.Left);
            this.il.StoreLocal(lhsSlot);
            this.il.LoadLocalAddress(lhsSlot);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(getHasValue);

            if (b.Op.Kind == BoundBinaryOperatorKind.Equals)
            {
                // !HasValue
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
            }

            return;
        }

        // Spill both operands.
        this.EmitExpression(b.Left);
        this.il.StoreLocal(lhsSlot);
        this.EmitExpression(b.Right);
        this.il.StoreLocal(rhsSlot);

        bool isEquality = b.Op.Kind == BoundBinaryOperatorKind.Equals
            || b.Op.Kind == BoundBinaryOperatorKind.NotEquals;
        bool isOrdering = b.Op.Kind == BoundBinaryOperatorKind.Less
            || b.Op.Kind == BoundBinaryOperatorKind.LessOrEquals
            || b.Op.Kind == BoundBinaryOperatorKind.Greater
            || b.Op.Kind == BoundBinaryOperatorKind.GreaterOrEquals;

        if (isEquality)
        {
            this.EmitLiftedEquality(b.Op.Kind, lhsSlot, rhsSlot, leftUnderlying, leftUnderlyingClr, rightUnderlyingClr);
            return;
        }

        if (isOrdering)
        {
            this.EmitLiftedOrdering(b.Op.Kind, lhsSlot, rhsSlot, leftUnderlying, leftUnderlyingClr, rightUnderlyingClr);
            return;
        }

        // Arithmetic / bitwise: produces Nullable<R>. Result slot is
        // populated by the planner so the null branch can `initobj` a
        // default Nullable<R> and `ldloc` it as a value.
        if (slots.ResultSlot < 0)
        {
            throw new InvalidOperationException(
                $"Lifted binary operator '{b.Op.Kind}' produces Nullable<R> but no result slot was pre-allocated; "
                + "check LiftedBinaryOperatorCollector and the prepass in CollectLocalsAndLabels.");
        }

        // For heterogeneous enum arithmetic (enum? + int32? → enum?), the
        // result type may differ from the left underlying. Use the
        // operator's result type to determine the Nullable<R> wrapper.
        var resultNullable = (NullableTypeSymbol)b.Type;
        var resultUnderlying = resultNullable.UnderlyingType;
        var resultUnderlyingClr = resultUnderlying.ClrType
            ?? throw new InvalidOperationException(
                $"Lifted binary result Nullable<{resultUnderlying.Name}>: underlying has no CLR type.");

        this.EmitLiftedArithmetic(b.Op.Kind, lhsSlot, rhsSlot, slots.ResultSlot, leftUnderlying, leftUnderlyingClr, rightUnderlyingClr, resultUnderlyingClr);
    }

    private void EmitLiftedEquality(
        BoundBinaryOperatorKind kind,
        int lhsSlot,
        int rhsSlot,
        TypeSymbol underlying,
        Type leftUnderlyingClr,
        Type rightUnderlyingClr)
    {
        var getHasValueLhs = this.outer.wellKnown.GetNullableGetHasValueReference(leftUnderlyingClr);
        var getHasValueRhs = this.outer.wellKnown.GetNullableGetHasValueReference(rightUnderlyingClr);
        var getValueLhs = this.outer.wellKnown.GetNullableGetValueReference(leftUnderlyingClr);
        var getValueRhs = this.outer.wellKnown.GetNullableGetValueReference(rightUnderlyingClr);

        var bothEmptyLabel = this.il.DefineLabel();
        var flagsAgreeLabel = this.il.DefineLabel();
        var end = this.il.DefineLabel();

        // Compare HasValue flags. If they differ, result is false.
        this.il.LoadLocalAddress(lhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getHasValueLhs);
        this.il.LoadLocalAddress(rhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getHasValueRhs);
        this.il.Branch(ILOpCode.Beq, flagsAgreeLabel);

        // Mismatched HasValue → false.
        this.il.LoadConstantI4(0);
        this.il.Branch(ILOpCode.Br, end);

        // Agreed: either both empty (→ true) or both present (→ underlying ceq).
        this.il.MarkLabel(flagsAgreeLabel);
        this.il.LoadLocalAddress(lhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getHasValueLhs);
        this.il.Branch(ILOpCode.Brfalse, bothEmptyLabel);

        // Both present: load values and compare.
        this.il.LoadLocalAddress(lhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getValueLhs);
        this.il.LoadLocalAddress(rhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getValueRhs);
        this.EmitUnderlyingEqualityCeq(underlying);
        this.il.Branch(ILOpCode.Br, end);

        this.il.MarkLabel(bothEmptyLabel);
        this.il.LoadConstantI4(1);

        this.il.MarkLabel(end);

        // For !=, append `ldc.i4.0; ceq` to negate.
        if (kind == BoundBinaryOperatorKind.NotEquals)
        {
            this.il.LoadConstantI4(0);
            this.il.OpCode(ILOpCode.Ceq);
        }
    }

    private void EmitLiftedOrdering(
        BoundBinaryOperatorKind kind,
        int lhsSlot,
        int rhsSlot,
        TypeSymbol underlying,
        Type leftUnderlyingClr,
        Type rightUnderlyingClr)
    {
        var getHasValueLhs = this.outer.wellKnown.GetNullableGetHasValueReference(leftUnderlyingClr);
        var getHasValueRhs = this.outer.wellKnown.GetNullableGetHasValueReference(rightUnderlyingClr);
        var getValueLhs = this.outer.wellKnown.GetNullableGetValueReference(leftUnderlyingClr);
        var getValueRhs = this.outer.wellKnown.GetNullableGetValueReference(rightUnderlyingClr);

        var falseLabel = this.il.DefineLabel();
        var end = this.il.DefineLabel();

        // (lhs.HasValue & rhs.HasValue) — if any is absent, result is false.
        this.il.LoadLocalAddress(lhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getHasValueLhs);
        this.il.LoadLocalAddress(rhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getHasValueRhs);
        this.il.OpCode(ILOpCode.And);
        this.il.Branch(ILOpCode.Brfalse, falseLabel);

        // Both present: load underlying values and compare.
        this.il.LoadLocalAddress(lhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getValueLhs);
        this.il.LoadLocalAddress(rhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getValueRhs);
        this.EmitUnderlyingOrdering(kind, underlying);
        this.il.Branch(ILOpCode.Br, end);

        this.il.MarkLabel(falseLabel);
        this.il.LoadConstantI4(0);

        this.il.MarkLabel(end);
    }

    private void EmitLiftedArithmetic(
        BoundBinaryOperatorKind kind,
        int lhsSlot,
        int rhsSlot,
        int resultSlot,
        TypeSymbol underlying,
        Type leftUnderlyingClr,
        Type rightUnderlyingClr,
        Type resultUnderlyingClr)
    {
        var getHasValueLhs = this.outer.wellKnown.GetNullableGetHasValueReference(leftUnderlyingClr);
        var getHasValueRhs = this.outer.wellKnown.GetNullableGetHasValueReference(rightUnderlyingClr);
        var getValueLhs = this.outer.wellKnown.GetNullableGetValueReference(leftUnderlyingClr);
        var getValueRhs = this.outer.wellKnown.GetNullableGetValueReference(rightUnderlyingClr);

        // Resolve Nullable<R> ctor / type tokens for the result.
        if (!NullableLifting.TryConstructNullable(this.outer.emitCtx.References, resultUnderlyingClr, out var nullableClr))
        {
            throw new InvalidOperationException(
                $"Cannot construct Nullable<{resultUnderlyingClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
        }

        var nullableInnerArg = nullableClr.GetGenericArguments()[0];
        var ctor = nullableClr.GetConstructor(new[] { nullableInnerArg })
            ?? throw new InvalidOperationException(
                $"Nullable<{nullableInnerArg.FullName}> has no single-arg constructor.");
        var nullableToken = this.outer.GetTypeHandleForMember(nullableClr);

        var nullBranch = this.il.DefineLabel();
        var end = this.il.DefineLabel();

        // Both present? If yes, fall through to compute; otherwise jump to null branch.
        this.il.LoadLocalAddress(lhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getHasValueLhs);
        this.il.LoadLocalAddress(rhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getHasValueRhs);
        this.il.OpCode(ILOpCode.And);
        this.il.Branch(ILOpCode.Brfalse, nullBranch);

        // Compute underlying op and wrap as Nullable<R>.
        this.il.LoadLocalAddress(lhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getValueLhs);
        this.il.LoadLocalAddress(rhsSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getValueRhs);
        this.EmitUnderlyingArithmetic(kind, underlying);
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.GetCtorReference(ctor));
        this.il.Branch(ILOpCode.Br, end);

        // Null branch: default(Nullable<R>) via initobj + ldloc.
        this.il.MarkLabel(nullBranch);
        this.il.LoadLocalAddress(resultSlot);
        this.il.OpCode(ILOpCode.Initobj);
        this.il.Token(nullableToken);
        this.il.LoadLocal(resultSlot);

        this.il.MarkLabel(end);
    }

    // Emits the IL for equality comparison on two values of `underlying`
    // already on the stack. Decimal routes through the static
    // op_Equality method; everything else uses `ceq`.
    private void EmitUnderlyingEqualityCeq(TypeSymbol underlying)
    {
        if (underlying == TypeSymbol.Decimal)
        {
            if (!this.TryEmitDecimalBinary(BoundBinaryOperatorKind.Equals))
            {
                throw new InvalidOperationException("Lifted decimal equality emit failed: decimal op_Equality is not resolvable.");
            }

            return;
        }

        this.il.OpCode(ILOpCode.Ceq);
    }

    // Emits the IL for an ordering comparison on two values of
    // `underlying` already on the stack. Mirrors the dispatch in
    // EmitBinary's bottom switch for less / less-or-equals / greater /
    // greater-or-equals: unsigned-or-char chooses the un-suffixed
    // variant, and a (clt/cgt) + (ldc.i4.0; ceq) negation is used for
    // <= and >=.
    private void EmitUnderlyingOrdering(BoundBinaryOperatorKind kind, TypeSymbol underlying)
    {
        if (underlying == TypeSymbol.Decimal)
        {
            if (!this.TryEmitDecimalBinary(kind))
            {
                throw new InvalidOperationException($"Lifted decimal '{kind}' emit failed.");
            }

            return;
        }

        bool isUnsigned = IsUnsignedOrChar(underlying);
        switch (kind)
        {
            case BoundBinaryOperatorKind.Less:
                this.il.OpCode(isUnsigned ? ILOpCode.Clt_un : ILOpCode.Clt);
                break;
            case BoundBinaryOperatorKind.LessOrEquals:
                this.il.OpCode(isUnsigned ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            case BoundBinaryOperatorKind.Greater:
                this.il.OpCode(isUnsigned ? ILOpCode.Cgt_un : ILOpCode.Cgt);
                break;
            case BoundBinaryOperatorKind.GreaterOrEquals:
                this.il.OpCode(isUnsigned ? ILOpCode.Clt_un : ILOpCode.Clt);
                this.il.LoadConstantI4(0);
                this.il.OpCode(ILOpCode.Ceq);
                break;
            default:
                throw new NotSupportedException($"EmitUnderlyingOrdering: unexpected kind '{kind}'.");
        }
    }

    // Emits the IL for an arithmetic or bitwise op on two values of
    // `underlying` already on the stack. Decimal routes through static
    // op_* methods; primitive types map to the matching opcode and then
    // apply sub-i4 truncation when the underlying is byte / sbyte /
    // short / ushort / char.
    private void EmitUnderlyingArithmetic(BoundBinaryOperatorKind kind, TypeSymbol underlying)
    {
        if (underlying == TypeSymbol.Decimal)
        {
            if (!this.TryEmitDecimalBinary(kind))
            {
                throw new NotSupportedException($"Lifted decimal '{kind}' emit failed.");
            }

            return;
        }

        bool isUnsigned = IsUnsignedOrChar(underlying);
        switch (kind)
        {
            case BoundBinaryOperatorKind.Sum:
                this.il.OpCode(ILOpCode.Add);
                break;
            case BoundBinaryOperatorKind.Difference:
                this.il.OpCode(ILOpCode.Sub);
                break;
            case BoundBinaryOperatorKind.Product:
                this.il.OpCode(ILOpCode.Mul);
                break;
            case BoundBinaryOperatorKind.Quotient:
                this.il.OpCode(isUnsigned ? ILOpCode.Div_un : ILOpCode.Div);
                break;
            case BoundBinaryOperatorKind.Remainder:
                this.il.OpCode(isUnsigned ? ILOpCode.Rem_un : ILOpCode.Rem);
                break;
            case BoundBinaryOperatorKind.BitwiseAnd:
                this.il.OpCode(ILOpCode.And);
                break;
            case BoundBinaryOperatorKind.BitwiseOr:
                this.il.OpCode(ILOpCode.Or);
                break;
            case BoundBinaryOperatorKind.BitwiseXor:
                this.il.OpCode(ILOpCode.Xor);
                break;
            case BoundBinaryOperatorKind.BitClear:
                this.il.OpCode(ILOpCode.Not);
                this.il.OpCode(ILOpCode.And);
                break;
            default:
                throw new NotSupportedException($"EmitUnderlyingArithmetic: unexpected kind '{kind}'.");
        }

        EmitNarrowingTruncationIfNeeded(kind, underlying);
    }

    private void EmitClrBinaryOperator(BoundClrBinaryOperatorExpression op)
    {
        // Stream C emit parity: user-defined binary operator on a CLR type.
        // C# operators are public-static methods, so we emit `call` against
        // the resolved MethodInfo with both arguments pushed in source
        // order.
        this.EmitExpression(op.Left);
        this.EmitExpression(op.Right);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(op.Method));
        this.EmitErasedObjectReturnWidening(TypeSymbol.FromClrType(op.Method.ReturnType), op.Type);
    }

    private void EmitClrUnaryOperator(BoundClrUnaryOperatorExpression op)
    {
        // Stream C emit parity: user-defined unary operator on a CLR type.
        this.EmitExpression(op.Operand);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(op.Method));
        this.EmitErasedObjectReturnWidening(TypeSymbol.FromClrType(op.Method.ReturnType), op.Type);
    }
}
