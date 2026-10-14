// <copyright file="MethodBodyEmitter.Operators.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import GSharp.Core.CodeAnalysis

/// PR-E-11 partial of (cref:MethodBodyEmitter):
/// unary/binary operators, shift guards, narrowing truncation.
/// See `MethodBodyEmitter.cs` for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
internal partial class MethodBodyEmitter {
    private func EmitUnary(u BoundUnaryExpression) {
        // Phase 3.C.3: `!!` is a runtime null-assertion. Emit a check
        // ahead of the operand load so we don't accidentally take a
        // dependency on stack tracking inside the operand.
        if u.Op.Kind == BoundUnaryOperatorKind.NullAssertion {
            // Issue #1572 / #2333: a value-type `Nullable<T>` operand where T
            // is a user-declared value type (value-kind struct or enum)
            // emitted in this compilation, OR an open type parameter
            // constrained to `struct` (its `Nullable<T>` instantiation closes
            // over a generic-parameter signature slot, not a resolvable host
            // `Type`). Either underlying has no runtime CLR type, so the
            // BCL-backed `get_Value` reference below cannot be built; spill the
            // struct to the pre-allocated `Nullable<T>` slot, take its address,
            // and call `Nullable<T>::get_Value()` off a TypeSpec MemberRef that
            // closes `Nullable<>` over the emitted TypeDef/TypeSpec or the
            // generic-parameter slot. Mirrors the primitive value-type arm
            // below (issue #504).
            if u.Operand.Type is NullableTypeSymbol userVtNullable && NullableLifting.RequiresSymbolicNullableGetValue(
                userVtNullable
            ) {
                if !this.receiverSpillSlots.TryGetValue(u.Operand, out var userVtSlot) {
                    throw InvalidOperationException(
                        "No scratch slot pre-allocated for user value-type Nullable<T> '!!' operand — check NullableValueTypeUnwrapCollector and the prepass in CollectLocalsAndLabels."
                    )
                }
                this.EmitExpression(u.Operand)
                this.il.StoreLocal(userVtSlot)
                this.il.LoadLocalAddress(userVtSlot)
                this.il.OpCode(ILOpCode.Call)
                this.il.Token(this.outer.memberRefs.GetNullableGetValueMemberRefForUserValueType(userVtNullable))
                return
            }
            // Issue #504: a value-type `Nullable<T>` operand cannot use
            // `dup; brtrue` (the `Nullable<T>` struct on the stack has no
            // valid `brtrue` interpretation — it produces invalid IL).
            // Instead, spill the struct to a pre-allocated `Nullable<T>`
            // slot, take its address, and call `Nullable<T>::get_Value()`,
            // which returns the underlying T or throws
            // `InvalidOperationException` when `HasValue == false`. This
            // matches the BCL `Nullable<T>.Value` property's semantics.
            if u
                .Operand
                .Type is NullableTypeSymbol operandNullable &&
                operandNullable
                .UnderlyingType
                ?.ClrType is {IsValueType: true} innerClr {
                if !this.receiverSpillSlots.TryGetValue(u.Operand, out var unwrapSlot) {
                    throw InvalidOperationException(
                        "No scratch slot pre-allocated for value-type Nullable<T> '!!' operand — check NullableValueTypeUnwrapCollector and the prepass in CollectLocalsAndLabels."
                    )
                }
                this.EmitExpression(u.Operand)
                this.il.StoreLocal(unwrapSlot)
                this.il.LoadLocalAddress(unwrapSlot)
                this.il.OpCode(ILOpCode.Call)
                this.il.Token(this.outer.wellKnown.GetNullableGetValueReference(innerClr))
                return
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
            if TryGetOpenTypeParameter(u.Operand.Type, out var tpOperand) {
                if !this.receiverSpillSlots.TryGetValue(u.Operand, out var tpUnwrapSlot) {
                    throw InvalidOperationException(
                        "No scratch slot pre-allocated for class-constrained `T?` / open `T` '!!' operand — check NullableValueTypeUnwrapCollector and the prepass in CollectLocalsAndLabels."
                    )
                }
                let tpToken = this.outer.memberRefs.GetElementTypeToken(tpOperand)
                let tpNonNull = this.il.DefineLabel()
                this.EmitExpression(u.Operand)
                this.il.StoreLocal(tpUnwrapSlot)
                this.il.LoadLocal(tpUnwrapSlot)
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(tpToken)
                this.il.Branch(ILOpCode.Brtrue, tpNonNull)
                this.EmitNullAssertionThrow(u.PlatformCheckMessage)
                this.il.MarkLabel(tpNonNull)
                this.il.LoadLocal(tpUnwrapSlot)
                return
            }
            // Issue #2333: an operand whose static type is a bare value type
            // — NOT wrapped in `NullableTypeSymbol` — can never be a CLR
            // `null`: value types have no "no value" bit pattern on the
            // evaluation stack outside of the `Nullable<T>` wrapper handled
            // by the arms above. This shape arises two ways:
            //
            //   * Control-flow smart-cast narrowing: `BuildNarrowedRead`
            //     (ExpressionBinder) already wraps a narrowed nullable
            //     value-type read in a synthesized inner `!!`, so a
            //     user-written `x!!` over an already-narrowed `x` sees an
            //     operand whose static type is the bare underlying `T` (the
            //     inner synthesized unwrap already proved/produced it). Any
            //     second check here is provably redundant.
            //
            //   * A direct `!!` written over an already non-nullable value
            //     (float/double, a BCL or user struct/enum, a
            //     struct-constrained type parameter, or even a plain
            //     int32/bool): the bottom `dup; brtrue` fallback is not just
            //     redundant here but UNSOUND — `brtrue` has no valid
            //     interpretation for a struct/float stack value (ilverify
            //     `StackUnexpected`), and even for the integral/bool/enum
            //     shapes that happen to verify, branching on the VALUE
            //     misidentifies a legitimate falsy-but-non-null value (`0`,
            //     `false`) as "null" and throws `NullReferenceException`
            //     incorrectly.
            //
            // Emit the operand and stop: no runtime check is meaningful for
            // a value that structurally cannot be nil.
            if IsNonNullableValueOperand(u.Operand.Type) {
                this.EmitExpression(u.Operand)
                return
            }
            this.EmitExpression(u.Operand)
            this.il.OpCode(ILOpCode.Dup)
            let nonNull = this.il.DefineLabel()
            this.il.Branch(ILOpCode.Brtrue, nonNull)
            this.il.OpCode(ILOpCode.Pop)
            this.EmitNullAssertionThrow(u.PlatformCheckMessage)
            this.il.MarkLabel(nonNull)
            return
        }
        // Issue #2544: predefined unary operators over Nullable<T> are lifted.
        // Identity preserves the wrapper; other operators branch on HasValue.
        if u
            .Operand
            .Type is NullableTypeSymbol liftedOperand &&
            u.Type is NullableTypeSymbol liftedResult &&
            NullableLifting
            .IsValueTypeNullable(liftedOperand) {
            if u.Op.Kind == BoundUnaryOperatorKind.Identity {
                this.EmitExpression(u.Operand)
                return
            }
            this.EmitLiftedNullableUnary(u, liftedOperand, liftedResult)
            return
        }
        // Issue #2023: checked integral negation (`-x` where x could be the
        // type's MinValue) must trap on overflow, matching #1881's checked
        // Sum/Difference/Product. Roslyn's own approach is followed: lower
        // `-x` to `0 - x` and emit it via the same overflow-trapping `sub.ovf`
        // used for checked binary subtraction, rather than the plain `neg`
        // opcode (whose 2's-complement semantics silently wrap MinValue back
        // to itself). This must happen *before* the generic
        // `this.EmitExpression(u.Operand)` below because the constant `0`
        // has to be pushed first.
        if u.Op.Kind == BoundUnaryOperatorKind.Negation && u.IsChecked && IsIntegralNegationOperand(u.Op.OperandType) {
            this.EmitCheckedIntegralNegation(u)
            return
        }
        this.EmitExpression(u.Operand)
        switch u.Op.Kind {
            case BoundUnaryOperatorKind.Identity { }
            case BoundUnaryOperatorKind.Negation {
                if u.Op.OperandType == TypeSymbol.Decimal {
                    let neg = BclMember.Method(typeof(decimal), "op_UnaryNegation", typeof(decimal))
                    this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(neg))
                } else {
                    this.il.OpCode(ILOpCode.Neg)
                }
            }
            case BoundUnaryOperatorKind.LogicalNegation {
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            case BoundUnaryOperatorKind.OnesComplement {
                this.il.OpCode(ILOpCode.Not)
            }
            default {
                throw NotSupportedException("Unary operator '${u.Op.Kind}' is not yet supported by the emitter.")
            }
        }
        if u.Op.Kind == BoundUnaryOperatorKind.OnesComplement || u.Op.Kind == BoundUnaryOperatorKind.Negation {
            EmitSubI4Truncation(u.Op.Type)
        }
    }

    private func EmitLiftedNullableUnary(
        u BoundUnaryExpression,
        operandNullable NullableTypeSymbol,
        resultNullable NullableTypeSymbol
    ) {
        if operandNullable != resultNullable {
            throw NotSupportedException(
                "Lifted unary operator '${u.Op.Kind}' with differing operand and result types is not supported."
            )
        }
        if !this.receiverSpillSlots.TryGetValue(u.Operand, out var slot) {
            throw InvalidOperationException("No scratch slot pre-allocated for lifted unary operator '${u.Op.Kind}'.")
        }
        let nullResult = this.il.DefineLabel()
        let end = this.il.DefineLabel()
        this.EmitExpression(u.Operand)
        this.il.StoreLocal(slot)
        this.il.LoadLocalAddress(slot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(this.GetNullableHasValueRef(operandNullable))
        this.il.Branch(ILOpCode.Brfalse, nullResult)
        let underlying = operandNullable.UnderlyingType
        if u.Op.Kind == BoundUnaryOperatorKind.Negation && u.IsChecked && IsIntegralNegationOperand(underlying) {
            if underlying == TypeSymbol.Int64 {
                this.il.LoadConstantI8(0)
            } else {
                this.il.LoadConstantI4(0)
            }
            this.EmitUnwrappedNullableValue(slot, operandNullable)
            this.il.OpCode(ILOpCode.Sub_ovf)
            if underlying == TypeSymbol.Int8 {
                this.il.OpCode(ILOpCode.Conv_ovf_i1)
            } else if underlying == TypeSymbol.Int16 {
                this.il.OpCode(ILOpCode.Conv_ovf_i2)
            }
        } else {
            this.EmitUnwrappedNullableValue(slot, operandNullable)
            switch u.Op.Kind {
                case BoundUnaryOperatorKind.Negation {
                    if underlying == TypeSymbol.Decimal {
                        let neg = BclMember.Method(typeof(decimal), "op_UnaryNegation", typeof(decimal))
                        this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(neg))
                    } else {
                        this.il.OpCode(ILOpCode.Neg)
                    }
                }
                case BoundUnaryOperatorKind.LogicalNegation {
                    this.il.LoadConstantI4(0)
                    this.il.OpCode(ILOpCode.Ceq)
                }
                case BoundUnaryOperatorKind.OnesComplement {
                    this.il.OpCode(ILOpCode.Not)
                }
                default {
                    throw NotSupportedException("Lifted unary operator '${u.Op.Kind}' is not supported.")
                }
            }
            if u.Op.Kind == BoundUnaryOperatorKind.OnesComplement || u.Op.Kind == BoundUnaryOperatorKind.Negation {
                this.EmitSubI4Truncation(underlying)
            }
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.GetNullableResultConstructor(resultNullable))
        this.il.Branch(ILOpCode.Br, end)
        this.il.MarkLabel(nullResult)
        this.il.LoadLocalAddress(slot)
        this.il.OpCode(ILOpCode.Initobj)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(resultNullable))
        this.il.LoadLocal(slot)
        this.il.MarkLabel(end)
    }

    /// Issue #2023: emits `checked(0 - x)` for an integral unary
    /// negation bound inside a `checked(...)`/`checked { }`
    /// context. The constant zero is pushed first (per ECMA-335 III.3.62's
    /// binary-numeric-operator table an `int32` literal freely combines
    /// with an `int32`-, sub-`int32`-, or native-int-typed value —
    /// only `int64` requires the widened `int64` zero), then the
    /// operand, then `sub.ovf` (never the `.un` variant: negation is
    /// only ever defined over the signed integral primitives). For the
    /// sub-`int32` operand widths (`sbyte`/`short`) the CLR
    /// promotes both operands to `int32` before subtracting, so
    /// `sub.ovf` alone cannot observe the exact-`MinValue`
    /// overflow (e.g. `0 - sbyte.MinValue` == 128, which fits an
    /// `int32` comfortably); a checked narrowing conversion
    /// (`conv.ovf.i1`/`conv.ovf.i2`) back to the operand's own
    /// width closes that gap, mirroring how checked narrowing conversions
    /// (issue #1881) already trap the same shape.
    private func EmitCheckedIntegralNegation(u BoundUnaryExpression) {
        let operandType = u.Op.OperandType
        if operandType == TypeSymbol.Int64 {
            this.il.LoadConstantI8(0)
        } else {
            this.il.LoadConstantI4(0)
        }
        this.EmitExpression(u.Operand)
        this.il.OpCode(ILOpCode.Sub_ovf)
        if operandType == TypeSymbol.Int8 {
            this.il.OpCode(ILOpCode.Conv_ovf_i1)
        } else if operandType == TypeSymbol.Int16 {
            this.il.OpCode(ILOpCode.Conv_ovf_i2)
        }
    }

    private func EmitBinary(b BoundBinaryExpression) {
        // Issue #941 / Phase 3.C.3: `??` (NullCoalesce). Short-circuit on the left.
        if b.Op.Kind == BoundBinaryOperatorKind.NullCoalesce {
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
            let leftNullable NullableTypeSymbol? = b.Left.Type as NullableTypeSymbol
            if leftNullable != nil && !NullableLifting.RequiresSymbolicNullableGetValue(leftNullable) &&
                leftNullable
                .UnderlyingType
                ?.ClrType is {IsValueType: true} innerClr {
                if !this.nullableCoalesceSpillSlots.TryGetValue(b, out var slot) {
                    throw InvalidOperationException(
                        "No scratch slot pre-allocated for value-type Nullable<T> '??' LHS — check NullableValueTypeCoalesceCollector and the prepass in CollectLocalsAndLabels."
                    )
                }
                this.EmitExpression(b.Left)
                this.il.StoreLocal(slot)
                this.il.LoadLocalAddress(slot)
                this.il.OpCode(ILOpCode.Call)
                this.il.Token(this.outer.wellKnown.GetNullableGetHasValueReference(innerClr))
                let fallback = this.il.DefineLabel()
                let end = this.il.DefineLabel()
                this.il.Branch(ILOpCode.Brfalse, fallback)
                // Non-null branch: reproduce the operator's result type.
                if b.Type is NullableTypeSymbol {
                    // Result is `Nullable<T>` — push the spilled wrapper as
                    // a value. Reloading the slot preserves the present
                    // wrapper (`HasValue == true`) so the consumer sees
                    // the same boxed/wrapped shape it would have observed
                    // had the coalesce been absent.
                    this.il.LoadLocal(slot)
                } else {
                    // Result is the underlying `T` — call `GetValueOrDefault()`
                    // off the slot's address. `HasValue == true` was just
                    // observed, so the value is present; routing through
                    // `GetValueOrDefault` (Issue #752 / ADR-0084 L3) avoids
                    // the BCL `get_Value` property's redundant HasValue check
                    // and throw path, producing a strictly cheaper IL shape
                    // with no boxing and no callvirt while still leaving the
                    // verifier-clean `T` on the stack.
                    this.il.LoadLocalAddress(slot)
                    this.il.OpCode(ILOpCode.Call)
                    this.il.Token(this.outer.wellKnown.GetNullableGetValueOrDefaultReference(innerClr))
                    // Issue #1239: when the best common type widened the left's
                    // underlying numeric type (e.g. `int32? ?? int64` → `int64`),
                    // convert the unwrapped underlying value to the result type so
                    // the non-null branch leaves a value of `b.Type` on the stack,
                    // matching the (already-converted) right branch.
                    if b.Type != leftNullable.UnderlyingType {
                        this.TryEmitNumericConversion(leftNullable.UnderlyingType, b.Type)
                    }
                }
                this.il.Branch(ILOpCode.Br, end)
                // Null branch: evaluate RHS, which the binder typed to
                // match the operator's result (either `T` or `Nullable<T>`).
                this.il.MarkLabel(fallback)
                this.EmitExpression(b.Right)
                this.il.MarkLabel(end)
                return
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
            if b
                .Left
                .Type is NullableTypeSymbol tpNullable &&
                tpNullable.UnderlyingType is TypeParameterSymbol tpUnderlying &&
                !tpUnderlying
                .HasValueTypeConstraint {
                if !this.nullableCoalesceSpillSlots.TryGetValue(b, out var tpSlot) {
                    throw InvalidOperationException(
                        "No scratch slot pre-allocated for class-constrained `T?` '??' LHS — check NullableValueTypeCoalesceCollector and the prepass in CollectLocalsAndLabels."
                    )
                }
                let tpToken = this.outer.memberRefs.GetElementTypeToken(tpUnderlying)
                let fallback = this.il.DefineLabel()
                let end = this.il.DefineLabel()
                this.EmitExpression(b.Left)
                this.il.StoreLocal(tpSlot)
                this.il.LoadLocal(tpSlot)
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(tpToken)
                this.il.Branch(ILOpCode.Brfalse, fallback)
                this.il.LoadLocal(tpSlot)
                this.il.Branch(ILOpCode.Br, end)
                this.il.MarkLabel(fallback)
                this.EmitExpression(b.Right)
                this.il.MarkLabel(end)
                return
            }
            // Issue #1516: NullCoalesce over a bare reference-typed type
            // parameter LHS — e.g. `x as T ?? fallback` where `T : SomeClass`,
            // interface-constrained, or unconstrained. `BoundAsExpression.Type`
            // for a reference target is the bare `T`, so the LHS is a
            // `TypeParameterSymbol` directly (NOT wrapped in
            // `NullableTypeSymbol`), and the Issue #831 branch above misses
            // it. The opaque `!!T` stack value cannot be probed with the
            // bottom `dup; brtrue` shape (ECMA-335 III.1.8), so mirror the
            // #831 box-probe spill: store the LHS to a `T`-typed slot, probe
            // its non-nullness via `box !!T; brfalse fallback`, and either
            // reload the slot (non-null) or evaluate RHS (fallback).
            if SlotPlanner.IsReferenceTypeParameterCoalesceProbe(b, out var bareTp) {
                if !this.nullableCoalesceSpillSlots.TryGetValue(b, out var bareSlot) {
                    throw InvalidOperationException(
                        "No scratch slot pre-allocated for bare reference-typed type-parameter '??' LHS — check NullableValueTypeCoalesceCollector and the prepass in CollectLocalsAndLabels."
                    )
                }
                let bareToken = this.outer.memberRefs.GetElementTypeToken(bareTp)
                let fallback = this.il.DefineLabel()
                let end = this.il.DefineLabel()
                this.EmitExpression(b.Left)
                this.il.StoreLocal(bareSlot)
                this.il.LoadLocal(bareSlot)
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(bareToken)
                this.il.Branch(ILOpCode.Brfalse, fallback)
                this.il.LoadLocal(bareSlot)
                this.il.Branch(ILOpCode.Br, end)
                this.il.MarkLabel(fallback)
                this.EmitExpression(b.Right)
                this.il.MarkLabel(end)
                return
            }
            // Issue #1578 / #2333: NullCoalesce over a "symbolic" value-type
            // nullable LHS — `Nullable<UserT>` where UserT is a user-declared
            // value-kind struct or enum emitted in this compilation (#1572),
            // OR `Nullable<T>` where T is an open type parameter constrained
            // to `struct` (its instantiation closes over a generic-parameter
            // signature slot, not a resolvable host `Type` — issue #2333's
            // audit of this sibling path). Both underlyings have no runtime
            // CLR type, so neither the primitive `Nullable<T>` spill arm at
            // the top (which probes via the BCL-backed `get_HasValue`) nor
            // the bottom `dup; brtrue` shape is usable. Mirror the sibling
            // value-type spill (#831 / #1516) with a box-probe over the
            // emitted/encoded `Nullable<T>` TypeSpec: spill the LHS to the
            // pre-allocated `Nullable<T>` slot, box it (boxing a
            // `Nullable<T>` yields `null` when `!HasValue`, else a boxed `T`
            // — ECMA-335 III.4.1), and `brfalse` to the fallback on the empty
            // case. On the non-null branch, reproduce the operator's result
            // type: reload the wrapper when the result is itself
            // `Nullable<T>`, else unwrap to `T` via the symbolic `get_Value`
            // MemberRef (#1572 / #2333), reusing the same
            // `RequiresSymbolicNullableGetValue` predicate and
            // `GetNullableGetValueMemberRefForUserValueType` helper that the
            // `!!` and `?.` emit paths use, rather than a separate special
            // case for the type-parameter shape.
            if b.Left.Type is NullableTypeSymbol userVtNullable && NullableLifting.RequiresSymbolicNullableGetValue(
                userVtNullable
            ) {
                if !this.nullableCoalesceSpillSlots.TryGetValue(b, out var userVtSlot) {
                    throw InvalidOperationException(
                        "No scratch slot pre-allocated for user value-type Nullable<T> '??' LHS — check NullableValueTypeCoalesceCollector and the prepass in CollectLocalsAndLabels."
                    )
                }
                let userVtBoxToken = this.outer.memberRefs.GetElementTypeToken(userVtNullable)
                let fallback = this.il.DefineLabel()
                let end = this.il.DefineLabel()
                this.EmitExpression(b.Left)
                this.il.StoreLocal(userVtSlot)
                this.il.LoadLocal(userVtSlot)
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(userVtBoxToken)
                this.il.Branch(ILOpCode.Brfalse, fallback)
                if b.Type is NullableTypeSymbol {
                    // Result is `Nullable<UserT>` — reload the present wrapper.
                    this.il.LoadLocal(userVtSlot)
                } else {
                    // Result is the underlying `UserT` — unwrap via get_Value.
                    this.il.LoadLocalAddress(userVtSlot)
                    this.il.OpCode(ILOpCode.Call)
                    this.il.Token(this.outer.memberRefs.GetNullableGetValueMemberRefForUserValueType(userVtNullable))
                }
                this.il.Branch(ILOpCode.Br, end)
                this.il.MarkLabel(fallback)
                this.EmitExpression(b.Right)
                this.il.MarkLabel(end)
                return
            }
            // Defensive: any other value-typed LHS remains unsupported by
            // `??`. All known value-type shapes are handled above (primitive
            // `Nullable<T>` #519, open class/unconstrained-type-parameter
            // `T?` #831, bare reference type-parameter #1516, symbolic
            // user-value-type / struct-constrained-generic-type-parameter
            // nullable #1578 / #2333); fail loudly rather than silently
            // producing PEVerify-rejected IL for any unanticipated
            // value-type stack shape.
            let leftType = b.Left.Type
            if ReflectionMetadataEmitter.IsValueTypeSymbol(leftType) {
                throw NotSupportedException(
                    "Null-coalesce '??' over value-type operand '${leftType?.Name}' is not yet supported by the emitter. " +
                        "The current `dup; brtrue` short-circuit is invalid IL for struct stack values; a HasValue/Value " +
                        "(or box-before-brtrue) emit path is required when nullable value types are supported."
                )
            }
            let resultType = b.Type
            this.EmitExpression(b.Left)
            this.EmitInterfaceMergeCastIfNeeded(b.Left, resultType)
            this.il.OpCode(ILOpCode.Dup)
            let done = this.il.DefineLabel()
            this.il.Branch(ILOpCode.Brtrue, done)
            this.il.OpCode(ILOpCode.Pop)
            this.EmitExpression(b.Right)
            this.EmitInterfaceMergeCastIfNeeded(b.Right, resultType)
            this.il.MarkLabel(done)
            return
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
        if this.liftedBinarySlots.TryGetValue(b, out var liftedSlots) {
            this.EmitLiftedNullableBinary(b, liftedSlots)
            return
        }
        if (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals) &&
            this.TryEmitNullableUserStructEquality(b) {
            return
        }
        if b.Op.IsDelegateCombination {
            this.EmitExpression(b.Left)
            this.EmitExpression(b.Right)
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(
                if b.Op.Kind == BoundBinaryOperatorKind.Sum {
                    this.outer.wellKnown.GetDelegateCombineRef()
                } else {
                    this.outer.wellKnown.GetDelegateRemoveRef()
                }
            )
            this.il.OpCode(ILOpCode.Castclass)
            let resultType = if b.Type is NullableTypeSymbol nullableResult {
                nullableResult.UnderlyingType
            } else {
                b.Type
            }
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(resultType))
            return
        }
        // Issue #1298: lifted equality / inequality over a nullable
        // user-defined enum (`E? == E?`, `E? == E`, `E? == nil`, …). A
        // user EnumSymbol has no static CLR type, so the value-type
        // Nullable<T> machinery above (gated on `ClrType`) never owns these
        // nodes. `box Nullable<E>` yields a managed-null reference when the
        // wrapper has no value and a boxed `E` otherwise (ECMA-335 III.4.1),
        // so dispatching through static `Object.Equals(object, object)`
        // reproduces C# `Nullable<T>` lifted equality: nil == nil → true,
        // nil == value → false, value == value → underlying compare. The
        // `nil`-literal arm boxes the single nullable operand and compares to
        // `ldnull`.
        if (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals) &&
            this.TryEmitNullableUserEnumEquality(b) {
            return
        }
        // String concatenation / equality go through BCL helpers. Issue #1927:
        // `+` also accepts `string?` mixed with `string` on either/both sides
        // (the operator table binds that combination too); at runtime a
        // `string?` operand is simply a possibly-null `string` reference, and
        // `String.Concat(string, string)` already treats a null argument as
        // an empty string (ECMA-335 / BCL contract), so no extra null-check
        // IL is needed — the existing Concat call handles it.
        if IsStringOrNullableStringEmit(b.Left.Type) && IsStringOrNullableStringEmit(b.Right.Type) {
            switch b.Op.Kind {
                case BoundBinaryOperatorKind.Sum {
                    this.EmitExpression(b.Left)
                    this.EmitExpression(b.Right)
                    this.il.Call(this.outer.wellKnown.GetStringConcatReference())
                    return
                }
                case BoundBinaryOperatorKind.Equals {
                    this.EmitExpression(b.Left)
                    this.EmitExpression(b.Right)
                    this.il.Call(this.outer.wellKnown.GetStringEqualsReference())
                    return
                }
                case BoundBinaryOperatorKind.NotEquals {
                    this.EmitExpression(b.Left)
                    this.EmitExpression(b.Right)
                    this.il.Call(this.outer.wellKnown.GetStringEqualsReference())
                    this.il.LoadConstantI4(0)
                    this.il.OpCode(ILOpCode.Ceq)
                    return
                }
                default {
                    let _ = 0
                }
            }
        }
        // Phase 7.4 / ADR-0033: inline structs compare their single field directly.
        if b
            .Left
            .Type is StructSymbol inlineStruct &&
            inlineStruct.IsInline &&
            b
            .Right
            .Type == inlineStruct &&
            (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals) {
            let field = inlineStruct.Fields[0]
            // Route through ResolveFieldToken so a generic inline struct
            // (e.g. `inline struct Box<T>`) emits a self-instantiation
            // MemberRef rather than a bare open FieldDef, which ILVerify
            // rejects ("found ref Box<T0>, expected ref Box"). Non-generic
            // inline structs still resolve to the bare FieldDef unchanged.
            let fieldHandle = this.outer.userTokens.ResolveFieldToken(inlineStruct, field)
            this.EmitExpression(b.Left)
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(fieldHandle)
            if ReflectionMetadataEmitter.IsValueTypeSymbol(field.Type) {
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(field.Type))
            }
            this.EmitExpression(b.Right)
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(fieldHandle)
            if ReflectionMetadataEmitter.IsValueTypeSymbol(field.Type) {
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(field.Type))
            }
            this.il.Call(
                if field.Type == TypeSymbol.String {
                    this.outer.wellKnown.GetStringEqualsReference()
                } else {
                    this.outer.wellKnown.GetObjectStaticEqualsReference()
                }
            )
            if b.Op.Kind == BoundBinaryOperatorKind.NotEquals {
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            return
        }
        // Phase 3.B.2 / ADR-0029: structural == / != on data-struct
        // values. Box both operands and dispatch through static
        // Object.Equals(object, object) which routes through the
        // virtual ValueType.Equals override. Issue #2228: a data CLASS
        // operand is already a reference (no boxing needed/legal target —
        // `box` on a reference type is a verifier-legal no-op per ECMA-335,
        // but skip it outright since there is nothing to box).
        if b
            .Left
            .Type is StructSymbol ds &&
            ds.IsData &&
            b
            .Right
            .Type == ds &&
            (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals) {
            // Issue #2866: an imported data class/struct has no row in
            // StructTypeDefs (it is only a semantic aggregate projected off
            // an ImportedTypeSymbol), so the indexer threw KeyNotFound. Route
            // through GetElementTypeToken, which resolves a locally declared
            // struct to its TypeDef and an imported one to a TypeRef/TypeSpec,
            // and only compute it when a `box` is actually emitted.
            this.EmitExpression(b.Left)
            if !ds.IsClass {
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(ds))
            }
            this.EmitExpression(b.Right)
            if !ds.IsClass {
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(ds))
            }
            this.il.Call(this.outer.wellKnown.GetObjectStaticEqualsReference())
            if b.Op.Kind == BoundBinaryOperatorKind.NotEquals {
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            return
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
        if b
            .Left
            .Type is TypeParameterSymbol leftTp &&
            b
            .Right
            .Type is TypeParameterSymbol rightTp &&
            (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals) {
            this.EmitExpression(b.Left)
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(leftTp))
            this.EmitExpression(b.Right)
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(rightTp))
            this.il.Call(this.outer.wellKnown.GetObjectStaticEqualsReference())
            if b.Op.Kind == BoundBinaryOperatorKind.NotEquals {
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            return
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
        if (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals) &&
            TryMatchTypeParameterNilCompare(b, out var tpNilOperand) {
            this.EmitExpression(tpNilOperand!!)
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(tpNilOperand!!.Type))
            this.il.OpCode(ILOpCode.Ldnull)
            this.il.OpCode(ILOpCode.Ceq)
            if b.Op.Kind == BoundBinaryOperatorKind.NotEquals {
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            return
        }
        // Issue #2188: reference equality (`==` / `!=`) where at least one
        // operand is an open type parameter or its nullable form (`T`, `T?`)
        // and the other side is another reference type (`object`, `object?`,
        // an interface, a user class, `T`, `T?`). The homogeneous `object ==
        // object` / bare `T == T` arms above do not own this mixed shape, and
        // the generic `Ceq` tail cannot compare an opaque VAR/MVAR stack slot
        // against a managed reference (ilverify rejects it — see the #831 note
        // above). Box each type-parameter-shaped operand first (`box !!T`,
        // which the JIT elides for a reference `T` and which yields a genuine
        // reference for `T?`), leaving already-reference operands untouched,
        // then compare the two references with `ceq`. This mirrors, for the
        // nullable / type-parameter cases, the reference-identity semantics the
        // `object == object` arm gets for free.
        if (b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals) &&
            (RefEqOperandNeedsBox(b.Left.Type) || RefEqOperandNeedsBox(b.Right.Type)) &&
            BoundBinaryOperator.IsReferenceEqualityOperand(b.Left.Type) &&
            BoundBinaryOperator
            .IsReferenceEqualityOperand(b.Right.Type) {
            this.EmitReferenceEqualityOperand(b.Left)
            this.EmitReferenceEqualityOperand(b.Right)
            this.il.OpCode(ILOpCode.Ceq)
            if b.Op.Kind == BoundBinaryOperatorKind.NotEquals {
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            return
        }
        // Short-circuit evaluation for logical `&&` and `||`: the right
        // operand must not be evaluated when the left operand already
        // determines the result. Emit a dup + conditional branch so the
        // LHS value is reused as the result without evaluating the RHS.
        if b.Op.Kind == BoundBinaryOperatorKind.LogicalAnd || b.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
            let endLabel = this.il.DefineLabel()
            this.EmitExpression(b.Left)
            this.il.OpCode(ILOpCode.Dup)
            this.il.Branch(
                if b.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                    ILOpCode.Brfalse
                } else {
                    ILOpCode.Brtrue
                },
                endLabel
            )
            this.il.OpCode(ILOpCode.Pop)
            this.EmitExpression(b.Right)
            this.il.MarkLabel(endLabel)
            return
        }
        this.EmitExpression(b.Left)
        this.EmitExpression(b.Right)
        if b.Left.Type == TypeSymbol.Decimal && b.Right.Type == TypeSymbol.Decimal {
            if this.TryEmitDecimalBinary(b.Op.Kind) {
                return
            }
        }
        let isUnsigned = IsUnsignedOrChar(b.Left.Type)
        // For `<=` and `>=` on floating-point operands the naive `!(a > b)` /
        // `!(a < b)` lowering (cgt/clt + ceq 0) gives the wrong answer when
        // either operand is NaN: IEEE 754 requires every ordered comparison
        // involving NaN to be false, so we must use the unordered variants
        // (cgt.un / clt.un) exactly as the relational-pattern lowering does.
        let isFloat = b.Left.Type == TypeSymbol.Float32 || b.Left.Type == TypeSymbol.Float64
        switch b.Op.Kind {
            case BoundBinaryOperatorKind.Sum {
                // Issue #1881: inside a `checked(...)`/`checked { }` context
                // (b.IsChecked), integral +/-/* trap on overflow via the
                // `.ovf` opcodes; floating-point never traps (IEEE 754
                // overflow saturates to infinity) so it always uses the
                // plain opcode regardless of the checked context.
                this.il.OpCode(
                    if b.IsChecked && !isFloat {
                        (
                            if isUnsigned {
                                ILOpCode.Add_ovf_un
                            } else {
                                ILOpCode.Add_ovf
                            }
                        )
                    } else {
                        ILOpCode.Add
                    }
                )
            }
            case BoundBinaryOperatorKind.Difference {
                this.il.OpCode(
                    if b.IsChecked && !isFloat {
                        (
                            if isUnsigned {
                                ILOpCode.Sub_ovf_un
                            } else {
                                ILOpCode.Sub_ovf
                            }
                        )
                    } else {
                        ILOpCode.Sub
                    }
                )
            }
            case BoundBinaryOperatorKind.Product {
                this.il.OpCode(
                    if b.IsChecked && !isFloat {
                        (
                            if isUnsigned {
                                ILOpCode.Mul_ovf_un
                            } else {
                                ILOpCode.Mul_ovf
                            }
                        )
                    } else {
                        ILOpCode.Mul
                    }
                )
            }
            case BoundBinaryOperatorKind.Quotient {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Div_un
                    } else {
                        ILOpCode.Div
                    }
                )
            }
            case BoundBinaryOperatorKind.Remainder {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Rem_un
                    } else {
                        ILOpCode.Rem
                    }
                )
            }
            case BoundBinaryOperatorKind.ShiftLeft {
                this.il.OpCode(ILOpCode.Shl)
            }
            case BoundBinaryOperatorKind.ShiftRight {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Shr_un
                    } else {
                        ILOpCode.Shr
                    }
                )
            }
            case BoundBinaryOperatorKind.UnsignedShiftRight {
                this.il.OpCode(ILOpCode.Shr_un)
            }
            case BoundBinaryOperatorKind.BitwiseAnd {
                this.il.OpCode(ILOpCode.And)
            }
            case BoundBinaryOperatorKind.BitwiseOr {
                this.il.OpCode(ILOpCode.Or)
            }
            case BoundBinaryOperatorKind.BitwiseXor {
                this.il.OpCode(ILOpCode.Xor)
            }
            case BoundBinaryOperatorKind.BitClear {
                // Go's a &^ b == a & ~b. Right operand is already on top: not, then and.
                this.il.OpCode(ILOpCode.Not)
                this.il.OpCode(ILOpCode.And)
            }
            case BoundBinaryOperatorKind.Equals {
                this.il.OpCode(ILOpCode.Ceq)
            }
            case BoundBinaryOperatorKind.NotEquals {
                this.il.OpCode(ILOpCode.Ceq)
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            case BoundBinaryOperatorKind.Less {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Clt_un
                    } else {
                        ILOpCode.Clt
                    }
                )
            }
            case BoundBinaryOperatorKind.LessOrEquals {
                this.il.OpCode(
                    if isUnsigned || isFloat {
                        ILOpCode.Cgt_un
                    } else {
                        ILOpCode.Cgt
                    }
                )
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            case BoundBinaryOperatorKind.Greater {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Cgt_un
                    } else {
                        ILOpCode.Cgt
                    }
                )
            }
            case BoundBinaryOperatorKind.GreaterOrEquals {
                this.il.OpCode(
                    if isUnsigned || isFloat {
                        ILOpCode.Clt_un
                    } else {
                        ILOpCode.Clt
                    }
                )
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            default {
                throw NotSupportedException("Binary operator '${b.Op.Kind}' is not yet supported by the emitter.")
            }
        }
        EmitNarrowingTruncationIfNeeded(b.Op.Kind, b.Type)
    }

    // Issue #1298: returns true when this binary node is a nullable
    // user-defined enum equality / inequality and emits the lifted
    // comparison via `box` + `Object.Equals` (or `box` + `ldnull; ceq`
    // for the `nil`-literal form). Returns false (emitting nothing) when
    // the node is not such a comparison, so the caller can fall through.
    private func TryEmitNullableUserEnumEquality(b BoundBinaryExpression) bool {
        let left = b.Left
        let right = b.Right
        let leftIsNullableEnum = IsNullableUserEnum(left.Type)
        let rightIsNullableEnum = IsNullableUserEnum(right.Type)
        // `E? == nil` / `nil == E?` (and `!=`): box the nullable operand
        // and compare the resulting reference against null.
        if leftIsNullableEnum && right.Type == TypeSymbol.Null {
            this.EmitBoxedNullableValueOperand(left)
            this.il.OpCode(ILOpCode.Ldnull)
            this.il.OpCode(ILOpCode.Ceq)
            this.EmitEqualityNegationIfNeeded(b.Op.Kind)
            return true
        }
        if rightIsNullableEnum && left.Type == TypeSymbol.Null {
            this.EmitBoxedNullableValueOperand(right)
            this.il.OpCode(ILOpCode.Ldnull)
            this.il.OpCode(ILOpCode.Ceq)
            this.EmitEqualityNegationIfNeeded(b.Op.Kind)
            return true
        }
        // `E? == E?`, `E? == E`, `E == E?`: at least one operand is a
        // nullable user enum and the other is the same user enum (nullable
        // or not). Box both operands with their own type token and dispatch
        // through static Object.Equals.
        let leftIsEnum = leftIsNullableEnum || left.Type is EnumSymbol
        let rightIsEnum = rightIsNullableEnum || right.Type is EnumSymbol
        if (leftIsNullableEnum || rightIsNullableEnum) && leftIsEnum && rightIsEnum {
            this.EmitBoxedNullableValueOperand(left)
            this.EmitBoxedNullableValueOperand(right)
            this.il.Call(this.outer.wellKnown.GetObjectStaticEqualsReference())
            this.EmitEqualityNegationIfNeeded(b.Op.Kind)
            return true
        }
        return false
    }

    private func TryEmitNullableUserStructEquality(b BoundBinaryExpression) bool {
        if b
            .Left
            .Type is not NullableTypeSymbol leftNullable ||
            b
            .Right
            .Type is not NullableTypeSymbol rightNullable ||
            leftNullable.UnderlyingType is not StructSymbol structural ||
            structural.IsClass ||
            (!structural.IsData && !structural.IsInline) ||
            structural != rightNullable.UnderlyingType {
            return false
        }
        this.EmitBoxedNullableValueOperand(b.Left)
        this.EmitBoxedNullableValueOperand(b.Right)
        this.il.Call(this.outer.wellKnown.GetObjectStaticEqualsReference())
        this.EmitEqualityNegationIfNeeded(b.Op.Kind)
        return true
    }

    private func EmitBoxedNullableValueOperand(operand BoundExpression) {
        this.EmitExpression(operand)
        this.il.OpCode(ILOpCode.Box)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(operand.Type))
    }

    // Issue #2188: pushes a reference-equality operand as an object reference,
    // boxing an open type-parameter operand (`box !!T`, a JIT no-op for a
    // reference `T`, and the reference-producing box for `T?`) and leaving
    // already-reference operands unboxed.
    private func EmitReferenceEqualityOperand(operand BoundExpression) {
        this.EmitExpression(operand)
        if RefEqOperandNeedsBox(operand.Type) {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(operand.Type))
        }
    }

    private func EmitEqualityNegationIfNeeded(kind BoundBinaryOperatorKind) {
        if kind == BoundBinaryOperatorKind.NotEquals {
            this.il.LoadConstantI4(0)
            this.il.OpCode(ILOpCode.Ceq)
        }
    }

    /// Emits the throw half of a null assertion: `newobj` +
    /// `throw`, choosing the message-carrying
    /// (cref:NullReferenceException) constructor for ADR-0186 §4's
    /// synthesized coercion check and the parameterless one for a
    /// user-written `!!`.
    /// @param platformCheckMessage The §4 message, or `null`.
    private func EmitNullAssertionThrow(platformCheckMessage string?) {
        if platformCheckMessage != nil {
            this.il.LoadString(this.outer.emitCtx.Metadata.GetOrAddUserString(platformCheckMessage))
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.outer.wellKnown.GetNullReferenceExceptionMessageCtorRef())
            this.il.OpCode(ILOpCode.Throw)
            return
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.wellKnown.GetNullReferenceExceptionCtorRef())
        this.il.OpCode(ILOpCode.Throw)
    }

    private func EmitNarrowingTruncationIfNeeded(kind BoundBinaryOperatorKind, resultType TypeSymbol) {
        // IL evaluation-stack quirk: arithmetic, bitwise, and shift
        // opcodes on sub-i4 operands produce an i4 result that is not
        // truncated to the operand's natural width. For correctness of
        // sbyte/byte/short/ushort/char result types, narrow back.
        //
        // Issue #534: enum types whose underlying CLR type is sub-i4
        // (e.g., a byte-backed [Flags] enum) need the same truncation.
        switch kind {
            case BoundBinaryOperatorKind.Sum,
            BoundBinaryOperatorKind.Difference,
            BoundBinaryOperatorKind.Product,
            BoundBinaryOperatorKind.Quotient,
            BoundBinaryOperatorKind.Remainder,
            BoundBinaryOperatorKind.ShiftLeft,
            BoundBinaryOperatorKind.ShiftRight,
            BoundBinaryOperatorKind.UnsignedShiftRight,
            BoundBinaryOperatorKind.BitwiseAnd,
            BoundBinaryOperatorKind.BitwiseOr,
            BoundBinaryOperatorKind.BitwiseXor,
            BoundBinaryOperatorKind.BitClear {
                EmitSubI4Truncation(resultType)
            }
            default {
                let _ = 0
            }
        }
    }

    /// Issue #534: emits a conv.i1 / conv.u1 / conv.i2 / conv.u2
    /// truncation instruction when [`resultType`](paramref) is a
    /// sub-i4 primitive <em>or</em> a CLR enum whose underlying type is
    /// sub-i4. This keeps the evaluation-stack value in the correct range
    /// after arithmetic, bitwise, or shift opcodes that always produce
    /// an i4 result.
    private func EmitSubI4Truncation(resultType TypeSymbol) {
        // Fast path: check built-in primitive types first.
        if resultType == TypeSymbol.Int8 {
            this.il.OpCode(ILOpCode.Conv_i1)
        } else if resultType == TypeSymbol.UInt8 {
            this.il.OpCode(ILOpCode.Conv_u1)
        } else if resultType == TypeSymbol.Int16 {
            this.il.OpCode(ILOpCode.Conv_i2)
        } else if resultType == TypeSymbol.UInt16 || resultType == TypeSymbol.Char {
            this.il.OpCode(ILOpCode.Conv_u2)
        } else if resultType?.ClrType != nil && resultType.ClrType!!.IsEnum {
            // Resolve the enum's underlying integral type and truncate
            // if it is narrower than i4.
            let underlying = Enum.GetUnderlyingType(resultType.ClrType!!)
            let underlyingFull = underlying.FullName
            if underlyingFull == "System.SByte" {
                this.il.OpCode(ILOpCode.Conv_i1)
            } else if underlyingFull == "System.Byte" {
                this.il.OpCode(ILOpCode.Conv_u1)
            } else if underlyingFull == "System.Int16" {
                this.il.OpCode(ILOpCode.Conv_i2)
            } else if underlyingFull == "System.UInt16" {
                this.il.OpCode(ILOpCode.Conv_u2)
            }
        }
    }

    // Issue #1232: G# shift semantics now match C#/CLR. The IL `shl`/`shr`/
    // `shr_un` opcodes mask the shift count to the low log2(stack-width) bits
    // (5 for an i4 stack slot — covering int32/uint32 and the sub-i4 types
    // promoted to i4 — and 6 for i8). Native-int operands mask to the runtime
    // pointer width. This is exactly C#'s behavior (`x << count` masks `count`
    // by `& 0x1F` for 32-bit operands and `& 0x3F` for 64-bit operands), so the
    // bare opcode is emitted directly with no count-range guard. (G# previously
    // followed Go, substituting zero when the count was >= the operand width.)
    private func TryEmitDecimalBinary(kind BoundBinaryOperatorKind) bool {
        let opName string? = switch kind {
            case BoundBinaryOperatorKind.Sum: "op_Addition"
            case BoundBinaryOperatorKind.Difference: "op_Subtraction"
            case BoundBinaryOperatorKind.Product: "op_Multiply"
            case BoundBinaryOperatorKind.Quotient: "op_Division"
            case BoundBinaryOperatorKind.Remainder: "op_Modulus"
            case BoundBinaryOperatorKind.Equals: "op_Equality"
            case BoundBinaryOperatorKind.NotEquals: "op_Inequality"
            case BoundBinaryOperatorKind.Less: "op_LessThan"
            case BoundBinaryOperatorKind.LessOrEquals: "op_LessThanOrEqual"
            case BoundBinaryOperatorKind.Greater: "op_GreaterThan"
            case BoundBinaryOperatorKind.GreaterOrEquals: "op_GreaterThanOrEqual"
            default: default(string?)
        }
        if opName == nil {
            return false
        }
        let op MethodInfo? = typeof(decimal).GetMethod(opName, []Type{typeof(decimal), typeof(decimal)})
        if op == nil {
            return false
        }
        this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(op))
        return true
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
    private func EmitLiftedNullableBinary(b BoundBinaryExpression, slots LiftedBinarySlots) {
        let leftNullable = cast[NullableTypeSymbol](b.Left.Type)
        let rightNullable = if b.Right.Type == TypeSymbol.Null {
            default(NullableTypeSymbol?)
        } else {
            cast[NullableTypeSymbol](b.Right.Type)
        }
        let leftUnderlying = leftNullable.UnderlyingType
        let lhsSlot = slots.LhsSlot
        let rhsSlot = slots.RhsSlot
        // Form 2: `x? == nil` / `x? != nil`. The IsNullCompare arm binds
        // this with right-operand type Null; the slot bundle has no RHS
        // and no result slot. Spill the LHS once and consult HasValue.
        // For `== nil` the result is `!HasValue`; for `!= nil` it is
        // `HasValue`. Issue #3626: route through GetNullableHasValueRef
        // rather than the ClrType-only well-known lookup — a tuple
        // underlying can have a symbolic-null ClrType (e.g. an element
        // carries a nullable-reference-type annotation), and this is the
        // only form reachable for `Nullable<TupleTypeSymbol>` since tuples
        // have no other lifted binary operators.
        if b.Right.Type == TypeSymbol.Null {
            let getHasValue = this.GetNullableHasValueRef(leftNullable)
            this.EmitExpression(b.Left)
            this.il.StoreLocal(lhsSlot)
            this.il.LoadLocalAddress(lhsSlot)
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(getHasValue)
            if b.Op.Kind == BoundBinaryOperatorKind.Equals {
                // !HasValue
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            return
        }
        let leftUnderlyingClr = leftUnderlying.ClrType ??
            throw InvalidOperationException(
            "Lifted binary operator '${b.Op.Kind}' on Nullable<${leftUnderlying.Name}>: underlying has no CLR type."
        )
        // Resolved only past the `x? == nil` arm above, which is the one form
        // that has no nullable right operand at all.
        let rightUnderlying = Invariant.Required(
            rightNullable,
            "lifted binary operator '${b.Op.Kind}': every form but the nil-compare handled above has a nullable right operand",
            expression: "rightNullable"
        )
            .UnderlyingType
        let rightUnderlyingClr = rightUnderlying.ClrType ??
            throw InvalidOperationException(
            "Lifted binary operator '${b.Op.Kind}' on Nullable<${rightUnderlying.Name}>: underlying has no CLR type."
        )
        // Spill both operands.
        this.EmitExpression(b.Left)
        this.il.StoreLocal(lhsSlot)
        this.EmitExpression(b.Right)
        this.il.StoreLocal(rhsSlot)
        let isEquality = b.Op.Kind == BoundBinaryOperatorKind.Equals || b.Op.Kind == BoundBinaryOperatorKind.NotEquals
        let isOrdering = b
            .Op
            .Kind == BoundBinaryOperatorKind.Less ||
            b
            .Op
            .Kind == BoundBinaryOperatorKind.LessOrEquals ||
            b
            .Op
            .Kind == BoundBinaryOperatorKind.Greater ||
            b
            .Op
            .Kind == BoundBinaryOperatorKind.GreaterOrEquals
        if isEquality {
            this.EmitLiftedEquality(b.Op.Kind, lhsSlot, rhsSlot, leftUnderlying, leftUnderlyingClr, rightUnderlyingClr)
            return
        }
        if isOrdering {
            this.EmitLiftedOrdering(b.Op.Kind, lhsSlot, rhsSlot, leftUnderlying, leftUnderlyingClr, rightUnderlyingClr)
            return
        }
        // Arithmetic / bitwise: produces Nullable<R>. Result slot is
        // populated by the planner so the null branch can `initobj` a
        // default Nullable<R> and `ldloc` it as a value.
        if slots.ResultSlot < 0 {
            throw InvalidOperationException(
                "Lifted binary operator '${b.Op.Kind}' produces Nullable<R> but no result slot was pre-allocated; " +
                    "check LiftedBinaryOperatorCollector and the prepass in CollectLocalsAndLabels."
            )
        }
        // For heterogeneous enum arithmetic (enum? + int32? → enum?), the
        // result type may differ from the left underlying. Use the
        // operator's result type to determine the Nullable<R> wrapper.
        let resultNullable = cast[NullableTypeSymbol](b.Type)
        let resultUnderlying = resultNullable.UnderlyingType
        let resultUnderlyingClr = resultUnderlying.ClrType ??
            throw InvalidOperationException(
            "Lifted binary result Nullable<${resultUnderlying.Name}>: underlying has no CLR type."
        )
        this.EmitLiftedArithmetic(
            b.Op.Kind,
            lhsSlot,
            rhsSlot,
            slots.ResultSlot,
            leftUnderlying,
            leftUnderlyingClr,
            rightUnderlyingClr,
            resultUnderlyingClr,
            b.IsChecked
        )
    }

    private func EmitLiftedEquality(
        kind BoundBinaryOperatorKind,
        lhsSlot int32,
        rhsSlot int32,
        underlying TypeSymbol,
        leftUnderlyingClr Type,
        rightUnderlyingClr Type
    ) {
        let getHasValueLhs = this.outer.wellKnown.GetNullableGetHasValueReference(leftUnderlyingClr)
        let getHasValueRhs = this.outer.wellKnown.GetNullableGetHasValueReference(rightUnderlyingClr)
        let getValueLhs = this.outer.wellKnown.GetNullableGetValueReference(leftUnderlyingClr)
        let getValueRhs = this.outer.wellKnown.GetNullableGetValueReference(rightUnderlyingClr)
        let bothEmptyLabel = this.il.DefineLabel()
        let flagsAgreeLabel = this.il.DefineLabel()
        let end = this.il.DefineLabel()
        // Compare HasValue flags. If they differ, result is false.
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueLhs)
        this.il.LoadLocalAddress(rhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueRhs)
        this.il.Branch(ILOpCode.Beq, flagsAgreeLabel)
        // Mismatched HasValue → false.
        this.il.LoadConstantI4(0)
        this.il.Branch(ILOpCode.Br, end)
        // Agreed: either both empty (→ true) or both present (→ underlying ceq).
        this.il.MarkLabel(flagsAgreeLabel)
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueLhs)
        this.il.Branch(ILOpCode.Brfalse, bothEmptyLabel)
        // Both present: load values and compare.
        // Issue #3518: ceq rejects arbitrary value types. Structural structs
        // use the same boxed Object.Equals semantics as non-lifted equality.
        let structural StructSymbol? = if underlying is StructSymbol candidate &&
            (candidate.IsData || candidate.IsInline) {
            candidate
        } else {
            default(StructSymbol?)
        }
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getValueLhs)
        if structural != nil {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(structural))
        }
        this.il.LoadLocalAddress(rhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getValueRhs)
        if structural != nil {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(structural))
            this.il.Call(this.outer.wellKnown.GetObjectStaticEqualsReference())
        } else {
            this.EmitUnderlyingEqualityCeq(underlying)
        }
        this.il.Branch(ILOpCode.Br, end)
        this.il.MarkLabel(bothEmptyLabel)
        this.il.LoadConstantI4(1)
        this.il.MarkLabel(end)
        // For !=, append `ldc.i4.0; ceq` to negate.
        if kind == BoundBinaryOperatorKind.NotEquals {
            this.il.LoadConstantI4(0)
            this.il.OpCode(ILOpCode.Ceq)
        }
    }

    private func EmitLiftedOrdering(
        kind BoundBinaryOperatorKind,
        lhsSlot int32,
        rhsSlot int32,
        underlying TypeSymbol,
        leftUnderlyingClr Type,
        rightUnderlyingClr Type
    ) {
        let getHasValueLhs = this.outer.wellKnown.GetNullableGetHasValueReference(leftUnderlyingClr)
        let getHasValueRhs = this.outer.wellKnown.GetNullableGetHasValueReference(rightUnderlyingClr)
        let getValueLhs = this.outer.wellKnown.GetNullableGetValueReference(leftUnderlyingClr)
        let getValueRhs = this.outer.wellKnown.GetNullableGetValueReference(rightUnderlyingClr)
        let falseLabel = this.il.DefineLabel()
        let end = this.il.DefineLabel()
        // (lhs.HasValue & rhs.HasValue) — if any is absent, result is false.
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueLhs)
        this.il.LoadLocalAddress(rhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueRhs)
        this.il.OpCode(ILOpCode.And)
        this.il.Branch(ILOpCode.Brfalse, falseLabel)
        // Both present: load underlying values and compare.
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getValueLhs)
        this.il.LoadLocalAddress(rhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getValueRhs)
        this.EmitUnderlyingOrdering(kind, underlying)
        this.il.Branch(ILOpCode.Br, end)
        this.il.MarkLabel(falseLabel)
        this.il.LoadConstantI4(0)
        this.il.MarkLabel(end)
    }

    private func EmitLiftedArithmetic(
        kind BoundBinaryOperatorKind,
        lhsSlot int32,
        rhsSlot int32,
        resultSlot int32,
        underlying TypeSymbol,
        leftUnderlyingClr Type,
        rightUnderlyingClr Type,
        resultUnderlyingClr Type,
        isChecked bool = false
    ) {
        let getHasValueLhs = this.outer.wellKnown.GetNullableGetHasValueReference(leftUnderlyingClr)
        let getHasValueRhs = this.outer.wellKnown.GetNullableGetHasValueReference(rightUnderlyingClr)
        let getValueLhs = this.outer.wellKnown.GetNullableGetValueReference(leftUnderlyingClr)
        let getValueRhs = this.outer.wellKnown.GetNullableGetValueReference(rightUnderlyingClr)
        // Resolve Nullable<R> ctor / type tokens for the result.
        if !NullableLifting.TryConstructNullable(
            this.outer.emitCtx.References,
            resultUnderlyingClr,
            out var nullableClr
        ) {
            throw InvalidOperationException(
                "Cannot construct Nullable<${resultUnderlyingClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
            )
        }
        let nullableInnerArg = nullableClr.GetGenericArguments()[0]
        let ctor = nullableClr.GetConstructor([]Type{nullableInnerArg}) ??
            throw InvalidOperationException("Nullable<${nullableInnerArg.FullName}> has no single-arg constructor.")
        let nullableToken = this.outer.memberRefs.GetTypeHandleForMember(nullableClr)
        let nullBranch = this.il.DefineLabel()
        let end = this.il.DefineLabel()
        // Both present? If yes, fall through to compute; otherwise jump to null branch.
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueLhs)
        this.il.LoadLocalAddress(rhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueRhs)
        this.il.OpCode(ILOpCode.And)
        this.il.Branch(ILOpCode.Brfalse, nullBranch)
        // Compute underlying op and wrap as Nullable<R>.
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getValueLhs)
        this.il.LoadLocalAddress(rhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getValueRhs)
        this.EmitUnderlyingArithmetic(kind, underlying, isChecked)
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
        this.il.Branch(ILOpCode.Br, end)
        // Null branch: default(Nullable<R>) via initobj + ldloc.
        this.il.MarkLabel(nullBranch)
        this.il.LoadLocalAddress(resultSlot)
        this.il.OpCode(ILOpCode.Initobj)
        this.il.Token(nullableToken)
        this.il.LoadLocal(resultSlot)
        this.il.MarkLabel(end)
    }

    // Emits the IL for equality comparison on two values of `underlying`
    // already on the stack. Decimal routes through the static
    // op_Equality method; everything else uses `ceq`.
    private func EmitUnderlyingEqualityCeq(underlying TypeSymbol) {
        if underlying == TypeSymbol.Decimal {
            if !this.TryEmitDecimalBinary(BoundBinaryOperatorKind.Equals) {
                throw InvalidOperationException(
                    "Lifted decimal equality emit failed: decimal op_Equality is not resolvable."
                )
            }
            return
        }
        this.il.OpCode(ILOpCode.Ceq)
    }

    // Emits the IL for an ordering comparison on two values of
    // `underlying` already on the stack. Mirrors the dispatch in
    // EmitBinary's bottom switch for less / less-or-equals / greater /
    // greater-or-equals: unsigned-or-char chooses the un-suffixed
    // variant, and a (clt/cgt) + (ldc.i4.0; ceq) negation is used for
    // <= and >=.
    private func EmitUnderlyingOrdering(kind BoundBinaryOperatorKind, underlying TypeSymbol) {
        if underlying == TypeSymbol.Decimal {
            if !this.TryEmitDecimalBinary(kind) {
                throw InvalidOperationException("Lifted decimal '$kind' emit failed.")
            }
            return
        }
        let isUnsigned = IsUnsignedOrChar(underlying)
        // See EmitBinary: `<=`/`>=` on floating-point operands need the
        // unordered comparison variants so NaN yields the IEEE 754 result.
        let isFloat = underlying == TypeSymbol.Float32 || underlying == TypeSymbol.Float64
        switch kind {
            case BoundBinaryOperatorKind.Less {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Clt_un
                    } else {
                        ILOpCode.Clt
                    }
                )
            }
            case BoundBinaryOperatorKind.LessOrEquals {
                this.il.OpCode(
                    if isUnsigned || isFloat {
                        ILOpCode.Cgt_un
                    } else {
                        ILOpCode.Cgt
                    }
                )
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            case BoundBinaryOperatorKind.Greater {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Cgt_un
                    } else {
                        ILOpCode.Cgt
                    }
                )
            }
            case BoundBinaryOperatorKind.GreaterOrEquals {
                this.il.OpCode(
                    if isUnsigned || isFloat {
                        ILOpCode.Clt_un
                    } else {
                        ILOpCode.Clt
                    }
                )
                this.il.LoadConstantI4(0)
                this.il.OpCode(ILOpCode.Ceq)
            }
            default {
                throw NotSupportedException("EmitUnderlyingOrdering: unexpected kind '$kind'.")
            }
        }
    }

    // Emits the IL for an arithmetic or bitwise op on two values of
    // `underlying` already on the stack. Decimal routes through static
    // op_* methods; primitive types map to the matching opcode and then
    // apply sub-i4 truncation when the underlying is byte / sbyte /
    // short / ushort / char.
    private func EmitUnderlyingArithmetic(kind BoundBinaryOperatorKind, underlying TypeSymbol, isChecked bool = false) {
        if underlying == TypeSymbol.Decimal {
            if !this.TryEmitDecimalBinary(kind) {
                throw NotSupportedException("Lifted decimal '$kind' emit failed.")
            }
            return
        }
        let isUnsigned = IsUnsignedOrChar(underlying)
        let isFloatUnderlying = underlying == TypeSymbol.Float32 || underlying == TypeSymbol.Float64
        switch kind {
            case BoundBinaryOperatorKind.Sum {
                // Issue #1881: lifted (Nullable<T>) checked arithmetic traps the
                // same as the non-lifted path — see EmitBinary below.
                this.il.OpCode(
                    if isChecked && !isFloatUnderlying {
                        (
                            if isUnsigned {
                                ILOpCode.Add_ovf_un
                            } else {
                                ILOpCode.Add_ovf
                            }
                        )
                    } else {
                        ILOpCode.Add
                    }
                )
            }
            case BoundBinaryOperatorKind.Difference {
                this.il.OpCode(
                    if isChecked && !isFloatUnderlying {
                        (
                            if isUnsigned {
                                ILOpCode.Sub_ovf_un
                            } else {
                                ILOpCode.Sub_ovf
                            }
                        )
                    } else {
                        ILOpCode.Sub
                    }
                )
            }
            case BoundBinaryOperatorKind.Product {
                this.il.OpCode(
                    if isChecked && !isFloatUnderlying {
                        (
                            if isUnsigned {
                                ILOpCode.Mul_ovf_un
                            } else {
                                ILOpCode.Mul_ovf
                            }
                        )
                    } else {
                        ILOpCode.Mul
                    }
                )
            }
            case BoundBinaryOperatorKind.Quotient {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Div_un
                    } else {
                        ILOpCode.Div
                    }
                )
            }
            case BoundBinaryOperatorKind.Remainder {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Rem_un
                    } else {
                        ILOpCode.Rem
                    }
                )
            }
            case BoundBinaryOperatorKind.BitwiseAnd {
                this.il.OpCode(ILOpCode.And)
            }
            case BoundBinaryOperatorKind.BitwiseOr {
                this.il.OpCode(ILOpCode.Or)
            }
            case BoundBinaryOperatorKind.BitwiseXor {
                this.il.OpCode(ILOpCode.Xor)
            }
            case BoundBinaryOperatorKind.BitClear {
                this.il.OpCode(ILOpCode.Not)
                this.il.OpCode(ILOpCode.And)
            }
            case BoundBinaryOperatorKind.ShiftLeft {
                this.il.OpCode(ILOpCode.Shl)
            }
            case BoundBinaryOperatorKind.ShiftRight {
                this.il.OpCode(
                    if isUnsigned {
                        ILOpCode.Shr_un
                    } else {
                        ILOpCode.Shr
                    }
                )
            }
            case BoundBinaryOperatorKind.UnsignedShiftRight {
                this.il.OpCode(ILOpCode.Shr_un)
            }
            default {
                throw NotSupportedException("EmitUnderlyingArithmetic: unexpected kind '$kind'.")
            }
        }
        EmitNarrowingTruncationIfNeeded(kind, underlying)
    }

    private func EmitClrBinaryOperator(op BoundClrBinaryOperatorExpression) {
        // Issue #2388: a nullable-lifted call site (either operand
        // Nullable<T>-wrapped — see TryLiftNullableClrOperatorOperands /
        // IsLiftedValueTypeClrBinary) was pre-planned into liftedBinarySlots
        // by SlotPlanner.LiftedBinaryOperatorCollector; falling through to
        // the naive push-push-call path below would leave a raw
        // Nullable<T> on the evaluation stack where the resolved operator
        // expects the bare underlying value — ilverify's StackUnexpected.
        if this.liftedBinarySlots.TryGetValue(op, out var liftedSlots) {
            this.EmitLiftedNullableClrBinary(op, liftedSlots)
            return
        }
        // Stream C emit parity: user-defined binary operator on a CLR type.
        // C# operators are public-static methods, so we emit `call` against
        // the resolved MethodInfo with both arguments pushed in source
        // order. (op.Function is never set on a non-lifted node — the
        // binder only produces the Function-carrying shape when lifting
        // applies, so it always has a liftedBinarySlots entry and is
        // handled above.)
        let operatorMethod = Invariant.Required(
            op.Method,
            "this is the imported-CLR-operator branch; the same-compilation form (issue #2388) carries Function instead and is handled above",
            expression: "op.Method"
        )
        this.EmitExpression(op.Left)
        this.EmitExpression(op.Right)
        this.EmitCallResolvedClrOrFunctionOperator(op)
        this.EmitErasedObjectReturnWidening(operatorMethod.ReturnType, op.Type)
    }

    // Issue #2388: mirrors EmitLiftedNullableBinary's HasValue/get_Value
    // skeleton, but for a Stream C/D custom-operator call
    // (BoundClrBinaryOperatorExpression) instead of the built-in operator
    // table. Because ClrOperatorResolution / the Stream D lookup resolve a
    // SEPARATE method per operator token (op_Equality vs op_Inequality vs
    // op_LessThan, ...; see OperatorNames.TryGetBinaryName), the resolved
    // op.Method/op.Function already IS the exact operator the source wrote
    // — there is no need to compute `!=` by negating `==`, unlike the
    // built-in table's EmitLiftedEquality. This lets every comparison kind
    // share one call-shaped "both present" branch that simply invokes the
    // resolved method/function; only the "not both present" fallback value
    // differs (per C# §12.4.8's lifted-equality vs lifted-ordering rules).
    private func EmitLiftedNullableClrBinary(op BoundClrBinaryOperatorExpression, slots LiftedBinarySlots) {
        let leftNullable = cast[NullableTypeSymbol](op.Left.Type)
        let rightNullable = cast[NullableTypeSymbol](op.Right.Type)
        let lhsSlot = slots.LhsSlot
        let rhsSlot = slots.RhsSlot
        if rhsSlot < 0 {
            throw InvalidOperationException(
                "Lifted CLR/user binary operator '${op.OperatorKind}': RHS slot missing — a nullable-lifted Stream " +
                    "C/D call site never has a `nil` RHS (see SlotPlanner.IsLiftedValueTypeClrBinary); check " +
                    "LiftedBinaryOperatorCollector."
            )
        }
        // Spill both operands.
        this.EmitExpression(op.Left)
        this.il.StoreLocal(lhsSlot)
        this.EmitExpression(op.Right)
        this.il.StoreLocal(rhsSlot)
        let isEquality = op.OperatorKind == SyntaxKind.EqualsEqualsToken
        let isInequality = op.OperatorKind == SyntaxKind.BangEqualsToken
        let isOrdering = (
            op.OperatorKind is SyntaxKind.LessToken or
                SyntaxKind.LessOrEqualsToken or
                SyntaxKind.GreaterToken or
                SyntaxKind.GreaterOrEqualsToken
        )
        if isEquality || isInequality {
            // §12.4.8: a HasValue mismatch (exactly one operand null) is
            // false for == and true for !=; both-null is true for == and
            // false for !=; both-present delegates to the resolved
            // operator (already the correct op_Equality / op_Inequality).
            this.EmitLiftedClrComparison(
                op,
                lhsSlot,
                rhsSlot,
                leftNullable,
                rightNullable,
                mismatchResult: isInequality,
                bothAbsentResult: !isInequality
            )
            return
        }
        if isOrdering {
            // Any missing operand makes every ordering comparison false —
            // there is no "both empty" special case (unlike equality).
            this.EmitLiftedClrComparison(
                op,
                lhsSlot,
                rhsSlot,
                leftNullable,
                rightNullable,
                mismatchResult: false,
                bothAbsentResult: false
            )
            return
        }
        this.EmitLiftedClrArithmetic(op, lhsSlot, rhsSlot, slots.ResultSlot, leftNullable, rightNullable)
    }

    // Both-present branch calls the resolved op.Method / op.Function
    // directly; the not-both-present branches produce a caller-supplied
    // constant per operator-family rules (see call sites above).
    private func EmitLiftedClrComparison(
        op BoundClrBinaryOperatorExpression,
        lhsSlot int32,
        rhsSlot int32,
        leftNullable NullableTypeSymbol,
        rightNullable NullableTypeSymbol,
        mismatchResult bool,
        bothAbsentResult bool
    ) {
        let getHasValueLhs = this.GetNullableHasValueRef(leftNullable)
        let getHasValueRhs = this.GetNullableHasValueRef(rightNullable)
        let flagsAgreeLabel = this.il.DefineLabel()
        let bothAbsentLabel = this.il.DefineLabel()
        let end = this.il.DefineLabel()
        // Compare HasValue flags; if they differ the result is the fixed
        // mismatch value for this operator family.
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueLhs)
        this.il.LoadLocalAddress(rhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueRhs)
        this.il.Branch(ILOpCode.Beq, flagsAgreeLabel)
        this.il.LoadConstantI4(
            if mismatchResult {
                1
            } else {
                0
            }
        )
        this.il.Branch(ILOpCode.Br, end)
        // Agreed: either both absent (fixed value) or both present (call
        // the resolved operator on the unwrapped values).
        this.il.MarkLabel(flagsAgreeLabel)
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueLhs)
        this.il.Branch(ILOpCode.Brfalse, bothAbsentLabel)
        this.EmitUnwrappedNullableValue(lhsSlot, leftNullable)
        this.EmitUnwrappedNullableValue(rhsSlot, rightNullable)
        this.EmitCallResolvedClrOrFunctionOperator(op)
        this.il.Branch(ILOpCode.Br, end)
        this.il.MarkLabel(bothAbsentLabel)
        this.il.LoadConstantI4(
            if bothAbsentResult {
                1
            } else {
                0
            }
        )
        this.il.MarkLabel(end)
    }

    private func EmitLiftedClrArithmetic(
        op BoundClrBinaryOperatorExpression,
        lhsSlot int32,
        rhsSlot int32,
        resultSlot int32,
        leftNullable NullableTypeSymbol,
        rightNullable NullableTypeSymbol
    ) {
        if resultSlot < 0 {
            throw InvalidOperationException(
                "Lifted CLR binary operator '${op.OperatorKind}' produces Nullable<R> but no result slot was " +
                    "pre-allocated; check LiftedBinaryOperatorCollector and the prepass in CollectLocalsAndLabels."
            )
        }
        let getHasValueLhs = this.GetNullableHasValueRef(leftNullable)
        let getHasValueRhs = this.GetNullableHasValueRef(rightNullable)
        if op.Type is not NullableTypeSymbol resultNullable {
            throw InvalidOperationException(
                "Lifted CLR/user binary operator '${op.OperatorKind}' must produce a nullable result."
            )
        }
        let nullableToken = this.outer.memberRefs.GetElementTypeToken(resultNullable)
        let nullableCtor = this.GetNullableResultConstructor(resultNullable)
        let nullBranch = this.il.DefineLabel()
        let end = this.il.DefineLabel()
        this.il.LoadLocalAddress(lhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueLhs)
        this.il.LoadLocalAddress(rhsSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValueRhs)
        this.il.OpCode(ILOpCode.And)
        this.il.Branch(ILOpCode.Brfalse, nullBranch)
        this.EmitUnwrappedNullableValue(lhsSlot, leftNullable)
        this.EmitUnwrappedNullableValue(rhsSlot, rightNullable)
        this.EmitCallResolvedClrOrFunctionOperator(op)
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(nullableCtor)
        this.il.Branch(ILOpCode.Br, end)
        this.il.MarkLabel(nullBranch)
        this.il.LoadLocalAddress(resultSlot)
        this.il.OpCode(ILOpCode.Initobj)
        this.il.Token(nullableToken)
        this.il.LoadLocal(resultSlot)
        this.il.MarkLabel(end)
    }

    private func GetNullableResultConstructor(nullable NullableTypeSymbol) EntityHandle {
        if NullableLifting.RequiresSymbolicNullableGetValue(nullable) &&
            !(nullable.UnderlyingType is TypeParameterSymbol) {
            return this.outer.memberRefs.GetNullableCtorMemberRefForUserValueType(nullable)
        }
        if nullable.UnderlyingType is TypeParameterSymbol typeParameter && typeParameter.HasValueTypeConstraint {
            return this.outer.memberRefs.GetNullableCtorMemberRefForOpenTypeParameter(nullable)
        }
        let resultUnderlyingClr = nullable
            .UnderlyingType
            ?.ClrType ??
            throw InvalidOperationException(
            "Lifted operator result '${nullable.UnderlyingType?.Name}' has no runtime or symbolic value-type representation."
        )
        if !NullableLifting.TryConstructNullable(
            this.outer.emitCtx.References,
            resultUnderlyingClr,
            out var nullableClr
        ) {
            throw InvalidOperationException(
                "Cannot construct Nullable<${resultUnderlyingClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
            )
        }
        let nullableInnerArg = nullableClr.GetGenericArguments()[0]
        let ctor = nullableClr.GetConstructor([]Type{nullableInnerArg}) ??
            throw InvalidOperationException("Nullable<${nullableInnerArg.FullName}> has no single-arg constructor.")
        return this.outer.memberRefs.GetCtorReference(ctor)
    }

    // Issue #2388: HasValue/Value accessors on Nullable<T> need different
    // MemberRef construction depending on whether T has a real runtime CLR
    // Type (imported CLR value type, e.g. DateTime) or is still
    // TypeBuilder-backed (same-compilation struct/enum) — mirrors the
    // existing get_Value split already used by the `(v!!)` unwrap operator
    // and the null-conditional receiver probe. Issue #3626: gated on the
    // broader RequiresSymbolicNullableGetValue (not IsUserValueTypeNullable)
    // so a tuple with a symbolic-null ClrType (e.g. an element carries a
    // nullable-reference-type annotation) also routes through the symbolic
    // MemberRef instead of dereferencing a null ClrType.
    private func GetNullableHasValueRef(nullable NullableTypeSymbol) MemberReferenceHandle {
        return if NullableLifting.RequiresSymbolicNullableGetValue(nullable) {
            this.outer.memberRefs.GetNullableGetHasValueMemberRefForUserValueType(nullable)
        } else {
            this
                .outer
                .wellKnown
                .GetNullableGetHasValueReference(
                Invariant.Required(
                    nullable.UnderlyingType.ClrType,
                    "a runtime nullable type has a CLR underlying type",
                    expression: "nullable.UnderlyingType.ClrType"
                )
            )
        }
    }

    private func GetNullableValueRef(nullable NullableTypeSymbol) MemberReferenceHandle {
        return if NullableLifting.RequiresSymbolicNullableGetValue(nullable) {
            this.outer.memberRefs.GetNullableGetValueMemberRefForUserValueType(nullable)
        } else {
            this
                .outer
                .wellKnown
                .GetNullableGetValueReference(
                Invariant.Required(
                    nullable.UnderlyingType.ClrType,
                    "a runtime nullable type has a CLR underlying type",
                    expression: "nullable.UnderlyingType.ClrType"
                )
            )
        }
    }

    private func EmitUnwrappedNullableValue(slot int32, nullable NullableTypeSymbol) {
        this.il.LoadLocalAddress(slot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(this.GetNullableValueRef(nullable))
    }

    // Dispatches the "both present" call to whichever carrier the node
    // holds — op.Method (imported CLR type, e.g. DateTime.op_Equality) via
    // reflection MemberRef, or op.Function (same-compilation struct
    // operator, e.g. Meters.op_Equality) via the ordinary
    // FunctionHandles/MethodHandles cache — mirroring the two-cache
    // fallback used by every other same-compilation call site
    // (EmitFunctionPointerFromMethod, BoundCallExpression emission). Issue
    // #2400 additionally routes a closed generic FunctionOwnerType through a
    // TypeSpec-parented MemberRef instead of calling the open MethodDef.
    private func EmitCallResolvedClrOrFunctionOperator(op BoundClrBinaryOperatorExpression) {
        if op.Function != nil {
            this.EmitCallResolvedUserFunction(op.Function, op.FunctionOwnerType)
            return
        }
        let method = Invariant.Required(
            op.Method,
            "this is the imported-CLR-operator branch; the same-compilation form (issue #2388) carries Function instead and is handled above",
            expression: "op.Method"
        )
        var owner = if op.Left.Type is NullableTypeSymbol nullableOwner {
            nullableOwner.UnderlyingType
        } else {
            op.Left.Type
        }
        let rightOwner = if op.Right.Type is NullableTypeSymbol nullableRight {
            nullableRight.UnderlyingType
        } else {
            op.Right.Type
        }
        if !ManagedReferenceTypes.TryGetElement(owner, out _, out _) && ManagedReferenceTypes.TryGetElement(
            rightOwner,
            out _,
            out _
        ) {
            owner = rightOwner
        }
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(
            if (
                NativeSliceTypes.IsDefinition(method.DeclaringType, out _) && NativeSliceTypes.TryGetElement(
                    owner,
                    out _,
                    out _
                )
            ) ||
                (
                ManagedReferenceTypes.IsDefinition(method.DeclaringType, out _) && ManagedReferenceTypes.TryGetElement(
                    owner,
                    out _,
                    out _
                )
            ) {
                this.outer.memberRefs.GetMethodEntityHandle(method, owner)
            } else {
                this.outer.memberRefs.GetMethodReference(method)
            }
        )
    }

    private func EmitCallResolvedUserFunction(function FunctionSymbol, functionOwnerType StructSymbol?) {
        var functionHandle EntityHandle
        if functionOwnerType != nil {
            functionHandle = this.outer.userTokens.ResolveUserStaticMethodToken(functionOwnerType, function)
        } else {
            if !this
                .outer
                .cache
                .FunctionHandles
                .TryGetValue(function, out var definitionHandle) &&
                !this
                .outer
                .cache
                .MethodHandles
                .TryGetValue(function, out definitionHandle) {
                throw InvalidOperationException(
                    "Same-compilation function '${function.Name}' has no emitted MethodDef."
                )
            }
            functionHandle = definitionHandle
        }
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(functionHandle)
    }

    private func EmitClrUnaryOperator(op BoundClrUnaryOperatorExpression) {
        // Stream C emit parity: user-defined unary operator on a CLR type.
        this.EmitExpression(op.Operand)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(this.outer.memberRefs.GetMethodReference(op.Method))
        this.EmitErasedObjectReturnWidening(op.Method.ReturnType, op.Type)
    }

    shared {
        /// Issue #2023: true when [`operandType`](paramref) is one of the
        /// signed integral primitives that unary negation (ADR-0044) is defined
        /// over — the only shapes where a checked context can observe overflow
        /// (floating-point negation never traps: IEEE 754 negation is exact, and
        /// (cref:TypeSymbol.Decimal) negation is handled by
        /// `decimal.op_UnaryNegation`, which is symmetric around zero and
        /// never overflows either).
        private func IsIntegralNegationOperand(operandType TypeSymbol) bool -> operandType == TypeSymbol.Int8 ||
            operandType == TypeSymbol.Int16 ||
            operandType == TypeSymbol.Int32 ||
            operandType == TypeSymbol.Int64 ||
            operandType == TypeSymbol.NInt

        // Issue #2188: true when a reference-equality operand is an open type
        // parameter (`T`) or its nullable form (`T?`) and therefore must be boxed
        // to a genuine object reference before `ceq` — the verifier cannot compare
        // an opaque VAR/MVAR stack slot against a managed reference. Already-
        // reference operands (`object`, `object?`, interfaces, user classes) leave
        // a reference on the stack and need no box.
        private func RefEqOperandNeedsBox(type TypeSymbol) bool -> type is TypeParameterSymbol ||
            (type is NullableTypeSymbol nullable && nullable.UnderlyingType is TypeParameterSymbol)

        private func IsNullableUserEnum(type TypeSymbol) bool -> type is NullableTypeSymbol nullable &&
            (nullable.UnderlyingType is EnumSymbol || (nullable.UnderlyingType is StructSymbol s && !s.IsClass))

        /// Issue #1927: true when [`type`](paramref) is `string`,
        /// `string?` or (ADR-0186 §6 / issue #4324) `string!`. All three
        /// are a possibly-null `string` reference at runtime, so the existing
        /// `String.Concat`/`String.Equals` IL handles them without extra
        /// null-checks. This must stay in step with the binder's
        /// `BoundBinaryOperator.IsStringOrNullableString`: the binder deciding
        /// the operator exists while the emitter declines to emit it is a
        /// crash, not a diagnostic.
        /// @param type The operand type.
        /// @returns Whether the operand is a string in any of the three states.
        private func IsStringOrNullableStringEmit(type TypeSymbol) bool -> type == TypeSymbol.String ||
            (type is NullableTypeSymbol nullable && nullable.UnderlyingType == TypeSymbol.String) ||
            (type is PlatformTypeSymbol platform && platform.UnderlyingType == TypeSymbol.String)

        /// Issue #831 / #2300: matches `T? == nil` / `T? != nil` AND bare
        /// `T == nil` / `T != nil` (and their symmetric `nil == ...` forms)
        /// where T is an open type parameter (class-constrained, struct-
        /// constrained-but-nullable-wrapped, interface-constrained, or
        /// unconstrained). The concrete value-type Nullable<T> arm
        /// (driven by (cref:liftedBinarySlots)) only catches
        /// operands with a static `ClrType`; open type parameters
        /// have none, so this match fills the gap. The caller boxes the
        /// matched operand using its full type token, which resolves to a
        /// bare reference slot for class/unconstrained/interface-constrained
        /// T (bare or `T?` — both have the same storage shape) and to
        /// `Nullable<!!T>` for a struct-constrained `T?` (a bare
        /// struct-constrained `T` never reaches here — the binder's
        /// `IsNullCompare` rejects it because it can never be nil).
        private func TryMatchTypeParameterNilCompare(
            node BoundBinaryExpression,
            @NotNullWhen(true) out operand BoundExpression?
        ) bool {
            if node.Right.Type == TypeSymbol.Null && IsOpenTypeParameterOrNullable(node.Left.Type) {
                operand = node.Left
                return true
            }
            if node.Left.Type == TypeSymbol.Null && IsOpenTypeParameterOrNullable(node.Right.Type) {
                operand = node.Right
                return true
            }
            operand = nil
            return false
        }

        /// Issue #831 / #2300: returns true when [`t`](paramref) is an
        /// open type parameter, either bare (`T`) or wrapped in a
        /// (cref:NullableTypeSymbol) (`T?`), regardless of
        /// constraint. The CLR storage is either a bare `!!T` reference
        /// slot (class/unconstrained/interface-constrained T, bare or `?` —
        /// same shape either way) or a `Nullable<!!T>` value-typed
        /// slot (struct-constrained `T?`) — see
        /// (cref:ImportedMemberRefFactory.GetElementTypeToken). Both
        /// shapes need the same `box; ldnull; ceq` lowering for nil-comparison
        /// to be verifier-clean: boxing a reference is a JIT-elided no-op,
        /// while boxing `Nullable<T>` per ECMA-335 III.4.1 yields a
        /// managed-null reference when HasValue is false.
        private func IsOpenTypeParameterOrNullable(t TypeSymbol) bool {
            return t is TypeParameterSymbol ||
                (t is NullableTypeSymbol nullable && nullable.UnderlyingType is TypeParameterSymbol)
        }

        /// Issue #831: returns true when [`t`](paramref) resolves to an
        /// open type parameter that is NOT struct-constrained, either
        /// directly (e.g. after a smart-cast narrowing) or via a
        /// (cref:NullableTypeSymbol) wrapper. Used by the `!!`
        /// (NullAssertion) emit path to recognise both `self T?` and the
        /// narrowed bare-`T` operand shape produced after a preceding
        /// nil-check guard.
        private func TryGetOpenTypeParameter(
            t TypeSymbol,
            @NotNullWhen(true) out typeParameter TypeParameterSymbol?
        ) bool {
            if t is TypeParameterSymbol bare && !bare.HasValueTypeConstraint {
                typeParameter = bare
                return true
            }
            if t is NullableTypeSymbol nullable &&
                nullable.UnderlyingType is TypeParameterSymbol wrapped &&
                !wrapped.HasValueTypeConstraint {
                typeParameter = wrapped
                return true
            }
            typeParameter = nil
            return false
        }

        /// Issue #2333: returns `true` when [`type`](paramref)
        /// is a bare (non-(cref:NullableTypeSymbol)) value type — a
        /// primitive, enum, struct, tuple, or a type parameter constrained to
        /// `struct`. Such a type's runtime representation on the evaluation
        /// stack is never a CLR `null`, so a null-assertion (`!!`) over
        /// it needs no runtime check at all. Used by `EmitUnary`'s
        /// (cref:BoundUnaryOperatorKind.NullAssertion) arm to recognise an
        /// operand that is either a direct non-nullable value or the result of a
        /// smart-cast-narrowed nullable value-type read (which
        /// (cref:ExpressionBinder)'s `BuildNarrowedRead` already
        /// unwrapped via a synthesized inner `!!`).
        /// @param type The operand's static type.
        /// @returns `true` when no runtime null check applies.
        private func IsNonNullableValueOperand(type TypeSymbol) bool {
            // ADR-0186: a platform wrapper is a REFERENCE-nullability annotation
            // (§2 excludes value types outright), so it can never make an operand
            // structurally non-nil. Listed explicitly beside its `T?` sibling so
            // the reference check below is reached by construction rather than by
            // `ClrType.IsValueType` happening to answer correctly through the
            // wrapper's relay.
            if type is NullableTypeSymbol || type is PlatformTypeSymbol {
                return false
            }
            if type is TypeParameterSymbol typeParameter {
                return typeParameter.HasValueTypeConstraint
            }
            return ReflectionMetadataEmitter.IsValueTypeSymbol(type)
        }
    }
}
