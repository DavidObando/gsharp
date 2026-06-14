// <copyright file="MethodBodyEmitter.Conversions.cs" company="GSharp">
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
/// conversion IL emission (absorbed from PR-E-5 Option B).
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

    private void EmitConversion(BoundConversionExpression conv)
    {
        // ADR-0059 / issue #255: GSharp function value → user-declared
        // named delegate type. The named delegate has no ClrType (its
        // TypeDef only exists in the assembly being emitted), so the
        // CLR-delegate path below cannot fire; emit the same
        // `ldnull/ldftn/newobj` (or closure `dup/ldftn/newobj`) sequence
        // but referencing the delegate's emitted ctor MethodDef handle
        // instead of a CLR ConstructorInfo.
        if (conv.Expression.Type is FunctionTypeSymbol namedSourceFn
            && conv.Type is DelegateTypeSymbol namedTargetDelegate)
        {
            this.EmitFunctionToNamedDelegateConversion(conv.Expression, namedSourceFn, namedTargetDelegate);
            return;
        }

        // Issue #295: GSharp function value → CLR delegate. This is the
        // general materialization that previously only happened in
        // argument position; routing it through EmitConversion makes
        // assignment, return, and cast positions emit the same delegate
        // instantiation IL.
        if (conv.Expression.Type is FunctionTypeSymbol sourceFn
            && conv.Type?.ClrType != null
            && ClrTypeUtilities.IsDelegateType(conv.Type.ClrType))
        {
            this.EmitFunctionToDelegateConversion(conv.Expression, sourceFn, conv.Type.ClrType);
            return;
        }

        this.EmitExpression(conv.Expression);
        var from = conv.Expression.Type;
        var to = conv.Type;
        if (from == to)
        {
            return;
        }

        // Phase 3.C.2 / ADR-0001: `nil` flows into any reference-typed
        // slot; the IL value is already ldnull. A reference-typed
        // `Nullable<T>` shares the CLR representation of the underlying
        // reference type, so ldnull is a valid value for it too.
        // Value-type `Nullable<T>` is the CLR struct `System.Nullable<T>`;
        // the binder lowers `nil → Nullable<value-type>` to a
        // BoundDefaultExpression so emission can materialise the proper
        // `ldloca; initobj; ldloc` shape from a pre-allocated slot. The
        // explicit IsValueTypeNullable guard here is defensive — if any
        // future binder path forgets to lower, fail loudly instead of
        // silently emitting an `ldnull` against a value-type slot
        // (issue #504).
        if (from == TypeSymbol.Null
            && ((to is NullableTypeSymbol toNullForNil && !ReflectionMetadataEmitter.IsValueTypeNullable(toNullForNil))
                || (to is StructSymbol ts && ts.IsClass)))
        {
            return;
        }

        if (from == TypeSymbol.Null && to is NullableTypeSymbol toValueNullForNil && ReflectionMetadataEmitter.IsValueTypeNullable(toValueNullForNil))
        {
            throw new InvalidOperationException(
                $"Conversion 'nil' -> '{to.Name}' (a value-type Nullable) must be lowered to a "
                + "BoundDefaultExpression by the binder so emit can allocate a temp slot for "
                + "ldloca/initobj/ldloc. Reaching EmitConversion indicates a missing lowering path.");
        }

        // Issue #504: value-type `T → Nullable<T>` is a true CLR widening;
        // emit `newobj Nullable<T>::.ctor(T)`. This must run before the
        // reference-compatibility shortcut below, which would otherwise
        // misclassify the lift as a no-op (the underlying primitive `T`
        // is trivially "compatible with" itself).
        if (to is NullableTypeSymbol toValueNullableLift
            && ReflectionMetadataEmitter.IsValueTypeNullable(toValueNullableLift)
            && from == toValueNullableLift.UnderlyingType)
        {
            // Issue #814 / ADR-0084 §L5: open `T → Nullable<T>` where T is an
            // open type parameter constrained to `struct`. The closed ctor
            // is unavailable (T has no CLR type), so we emit a MemberRef
            // parented at the TypeSpec `Nullable<!!T>` with signature
            // `instance void .ctor(!0)`. The CLR resolves `!0` against the
            // parent's first generic argument at call time.
            if (toValueNullableLift.UnderlyingType is TypeParameterSymbol)
            {
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.GetNullableCtorMemberRefForOpenTypeParameter(toValueNullableLift));
                return;
            }

            var innerClr = toValueNullableLift.UnderlyingType.ClrType
                ?? throw new InvalidOperationException(
                    $"Nullable<{toValueNullableLift.UnderlyingType.Name}> lift has no CLR underlying type.");

            // Issue #571: route the Nullable<T> construction through the
            // ReferenceResolver so the open `System.Nullable`1` definition and
            // the MLC-backed inner value type come from the same load context.
            // Building it from host `typeof(System.Nullable<>)` mixes the host
            // open generic with an MLC-backed `T`, which then fails inside
            // TypeBuilder/MetadataBuilder ctor-reference encoding as GS9998
            // with a bogus `(1,1,1,1)` cross-file location.
            if (!NullableLifting.TryConstructNullable(this.outer.emitCtx.References, innerClr, out var nullableClr))
            {
                throw new InvalidOperationException(
                    $"Cannot construct Nullable<{innerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
            }

            var nullableInnerArg = nullableClr.GetGenericArguments()[0];
            var ctor = nullableClr.GetConstructor(new[] { nullableInnerArg })
                ?? throw new InvalidOperationException(
                    $"Nullable<{nullableInnerArg.FullName}> has no single-arg constructor.");
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(ctor));
            return;
        }

        // Phase 3 exit: widening to a nullable reference type (`T` -> `T?`)
        // is metadata-only because reference nullability shares the CLR
        // representation. The same applies to narrowing back via `!!`.
        // Restrict to reference-type Nullable<T> — value-type Nullable<T>
        // is a distinct CLR struct and was handled by the dedicated branch
        // above (issue #504).
        if (to is NullableTypeSymbol toNullable
            && !ReflectionMetadataEmitter.IsValueTypeNullable(toNullable)
            && IsReferenceCompatible(from, toNullable.UnderlyingType))
        {
            return;
        }

        if (from is NullableTypeSymbol fromNullable
            && !ReflectionMetadataEmitter.IsValueTypeNullable(fromNullable)
            && IsReferenceCompatible(fromNullable.UnderlyingType, to))
        {
            return;
        }

        // Minimal numeric / to-string conversions sufficient for current language coverage.
        if (to == TypeSymbol.Int32 && from == TypeSymbol.Bool)
        {
            // bool already lives as i4 on the stack; no-op.
            return;
        }

        if (to == TypeSymbol.Bool && from == TypeSymbol.Int32)
        {
            this.il.LoadConstantI4(0);
            this.il.OpCode(ILOpCode.Ceq);
            this.il.LoadConstantI4(0);
            this.il.OpCode(ILOpCode.Ceq);
            return;
        }

        // Issue #638: numeric-widening + nullable wrapping: T1 → Nullable<T2>
        // where T1 is numerically convertible to T2 (e.g., int32 → int64?).
        // The exact-match case (T → Nullable<T>) was handled above; this
        // covers cross-width conversions that would otherwise be mishandled
        // by TryEmitNumericConversion below (which sees NullableTypeSymbol.ClrType
        // as the raw underlying type and emits only the conv.* without wrapping).
        if (to is NullableTypeSymbol toValueNullableWiden
            && ReflectionMetadataEmitter.IsValueTypeNullable(toValueNullableWiden)
            && from != toValueNullableWiden.UnderlyingType
            && TryEmitNumericConversion(from, toValueNullableWiden.UnderlyingType, conv.IsChecked))
        {
            var widenInnerClr = toValueNullableWiden.UnderlyingType.ClrType
                ?? throw new InvalidOperationException(
                    $"Nullable<{toValueNullableWiden.UnderlyingType.Name}> lift has no CLR underlying type.");

            if (!NullableLifting.TryConstructNullable(this.outer.emitCtx.References, widenInnerClr, out var widenNullableClr))
            {
                throw new InvalidOperationException(
                    $"Cannot construct Nullable<{widenInnerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
            }

            var widenNullableInnerArg = widenNullableClr.GetGenericArguments()[0];
            var widenCtor = widenNullableClr.GetConstructor(new[] { widenNullableInnerArg })
                ?? throw new InvalidOperationException(
                    $"Nullable<{widenNullableInnerArg.FullName}> has no single-arg constructor.");
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(widenCtor));
            return;
        }

        // ADR-0044 numeric conversion lattice. Any pair of numeric CLR
        // primitives (sbyte/byte/short/ushort/int/uint/long/ulong/nint/
        // nuint/float/double/decimal/char) gets a typed IL conversion.
        // Issue #421 P2-5: route a checked conversion through the
        // overflow-trapping `conv.ovf.*` variants when requested.
        if (TryEmitNumericConversion(from, to, conv.IsChecked))
        {
            return;
        }

        // Issue #421 P2-5: enum ⇄ numeric (and enum ⇄ enum) conversions.
        // CLR enums share storage with their underlying primitive, so we
        // simply re-route through the numeric lattice substituting the
        // underlying type on whichever side carries the enum.
        if (TryEmitEnumConversion(from, to, conv.IsChecked))
        {
            return;
        }

        if ((to?.ClrType.IsSameAs(typeof(object)) == true || IsInterfaceTargetType(to)) && ReflectionMetadataEmitter.IsValueTypeSymbol(from))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.GetElementTypeToken(from));
            return;
        }

        // ADR-0087 §3 R4: after R2 a value of `T` lives in a real type slot
        // (VAR/MVAR), not an erased `object`. Where the binder still emits a
        // BoundConversionExpression bridging `T → object` (e.g. passing a
        // generic value to a non-reified delegate parameter still bound as
        // `object`), emit `box T` so the JIT materialises the value-or-
        // reference boxed slot. The JIT elides the box when T resolves to a
        // reference type at runtime, so no perf regression.
        if (from is TypeParameterSymbol fromTp
            && (to?.ClrType.IsSameAs(typeof(object)) == true || IsInterfaceTargetType(to)))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.GetElementTypeToken(fromTp));
            return;
        }

        // ADR-0045 explicit unbox: `(T)objectValue` for a value type T.
        // Issue #421 P2-5: also fire when the source is an interface
        // reference (user-declared `InterfaceSymbol` or any CLR
        // interface), since a boxed value type held in an interface
        // slot needs `unbox.any` to surface as its native value type.
        if ((from?.ClrType.IsSameAs(typeof(object)) == true || IsInterfaceSourceType(from))
            && to?.ClrType != null && to.ClrType.IsValueType)
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.GetElementTypeToken(to));
            return;
        }

        if (from?.ClrType.IsSameAs(typeof(object)) == true
            && to?.ClrType.IsSameAs(typeof(object)) == false
            && to is not TypeParameterSymbol
            && !ReflectionMetadataEmitter.IsValueTypeSymbol(to))
        {
            this.il.OpCode(ILOpCode.Castclass);
            this.il.Token(this.outer.GetElementTypeToken(to));
            return;
        }

        // Phase D: class → interface upcast is a CLR reference-level
        // no-op. The receiver already implements the interface; loading
        // the reference into an interface-typed slot needs no IL.
        if (IsReferenceCompatible(from, to))
        {
            return;
        }

        // Issue #663: fall back to user-defined op_Implicit / op_Explicit when
        // no built-in emit path fires. This covers types like JsonNode that
        // expose conversion operators to string, int, bool, etc.
        if (from?.ClrType != null && to?.ClrType != null
            && ClrOperatorResolution.TryResolveConversion(from.ClrType, to.ClrType, allowExplicit: true, out var userConvMethod, out _))
        {
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(this.outer.GetMethodReference(userConvMethod));
            return;
        }

        throw new NotSupportedException(
            $"Conversion from '{from.Name}' to '{to.Name}' is not yet supported by the emitter.");
    }

    private void EmitErasedObjectReturnWidening(TypeSymbol runtimeReturnType, TypeSymbol expectedType)
    {
        if (!IsObjectStackType(runtimeReturnType)
            || expectedType == null
            || expectedType == TypeSymbol.Void
            || expectedType == TypeSymbol.Error
            || expectedType?.ClrType.IsSameAs(typeof(object)) == true)
        {
            return;
        }

        // ADR-0087 §3 R4: when the source is `object` (erased return from a
        // non-reified call site, e.g. IList::get_Item) and the target is a
        // type parameter or a generic-instantiation containing one, emit
        // `unbox.any T` (or `unbox.any List<!!0>` etc.). The JIT picks the
        // value-vs-reference shape from the instantiated `T` at call time.
        if (expectedType is TypeParameterSymbol expectedTp)
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.GetElementTypeToken(expectedTp));
            return;
        }

        if (TypeSymbol.ContainsTypeParameter(expectedType))
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.GetElementTypeToken(expectedType));
            return;
        }

        if (ReflectionMetadataEmitter.IsValueTypeSymbol(expectedType))
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.GetElementTypeToken(expectedType));
            return;
        }

        this.il.OpCode(ILOpCode.Castclass);
        this.il.Token(this.outer.GetElementTypeToken(expectedType));
    }

    // ADR-0044 numeric conversions. Maps the from/to CLR pair to the
    // appropriate `conv.*` opcode or, for `decimal`, to the matching
    // implicit/explicit operator method. Returns true when an emission
    // was made. Issue #421 P2-5: when <paramref name="isChecked"/> is
    // true the narrowing is emitted with the overflow-trapping
    // `conv.ovf.*` opcodes so values that don't fit the target throw
    // <see cref="System.OverflowException"/> instead of truncating.
    private bool TryEmitNumericConversion(TypeSymbol fromSym, TypeSymbol toSym, bool isChecked = false)
    {
        var from = fromSym?.ClrType;
        var to = toSym?.ClrType;
        if (from is null || to is null)
        {
            return false;
        }

        if (!IsNumericClrType(from) || !IsNumericClrType(to))
        {
            return false;
        }

        // decimal is a value type with no `conv.*` opcode; route through
        // the BCL's operator methods. `op_Implicit` for widening sources
        // (every integral type → decimal) and `op_Explicit` otherwise.
        if (to.IsSameAs(typeof(decimal)) || from.IsSameAs(typeof(decimal)))
        {
            return TryEmitDecimalConversion(from, to);
        }

        if (isChecked)
        {
            return TryEmitCheckedNumericConversion(from, to);
        }

        // Stack-type bookkeeping: anything narrower than i4 is widened to
        // i4 on the evaluation stack, so the source's stack shape is
        // determined by `from`'s size only when it's i8, native int, r4,
        // or r8. We pick the conv opcode that matches the *target*
        // representation.
        ILOpCode? op = null;
        if (to.IsSameAs(typeof(sbyte)))
        {
            op = ILOpCode.Conv_i1;
        }
        else if (to.IsSameAs(typeof(byte)))
        {
            op = ILOpCode.Conv_u1;
        }
        else if (to.IsSameAs(typeof(short)))
        {
            op = ILOpCode.Conv_i2;
        }
        else if (to.IsSameAs(typeof(ushort)) || to.IsSameAs(typeof(char)))
        {
            op = ILOpCode.Conv_u2;
        }
        else if (to.IsSameAs(typeof(int)))
        {
            // From an i4-sized source the value is already i4. From i8,
            // r4, r8, nint, nuint we must narrow to i4.
            if (Is32BitOrSmaller(from))
            {
                return true;
            }

            op = ILOpCode.Conv_i4;
        }
        else if (to.IsSameAs(typeof(uint)))
        {
            if (Is32BitOrSmaller(from))
            {
                return true;
            }

            op = ILOpCode.Conv_u4;
        }
        else if (to.IsSameAs(typeof(long)))
        {
            op = ILOpCode.Conv_i8;
        }
        else if (to.IsSameAs(typeof(ulong)))
        {
            op = ILOpCode.Conv_u8;
        }
        else if (to.IsSameAs(typeof(nint)))
        {
            op = ILOpCode.Conv_i;
        }
        else if (to.IsSameAs(typeof(nuint)))
        {
            op = ILOpCode.Conv_u;
        }
        else if (to.IsSameAs(typeof(float)))
        {
            op = ILOpCode.Conv_r4;
        }
        else if (to.IsSameAs(typeof(double)))
        {
            op = ILOpCode.Conv_r8;
        }

        if (op == null)
        {
            return false;
        }

        this.il.OpCode(op.Value);
        return true;
    }

    private bool TryEmitDecimalConversion(Type from, Type to)
    {
        // To decimal: every numeric source has either an `op_Implicit`
        // (integrals, char) or an `op_Explicit` (float, double).
        if (to.IsSameAs(typeof(decimal)))
        {
            var op = typeof(decimal).GetMethod("op_Implicit", new[] { from })
                ?? typeof(decimal).GetMethod("op_Explicit", new[] { from });
            if (op == null)
            {
                return false;
            }

            this.il.Call(this.outer.GetMethodEntityHandle(op));
            return true;
        }

        // From decimal: every numeric target has an `op_Explicit`.
        if (from.IsSameAs(typeof(decimal)))
        {
            var op = typeof(decimal).GetMethod("op_Explicit", new[] { typeof(decimal) });
            // GetMethod by name+params resolves the conversion that
            // returns the requested type when overloads disambiguate by
            // return type; iterate to find the right one.
            foreach (var m in typeof(decimal).GetMethods())
            {
                if (m.Name == "op_Explicit"
                    && m.ReturnType == to
                    && m.GetParameters().Length == 1
                    && m.GetParameters()[0].ParameterType.IsSameAs(typeof(decimal)))
                {
                    op = m;
                    break;
                }
            }

            if (op == null || op.ReturnType != to)
            {
                return false;
            }

            this.il.Call(this.outer.GetMethodEntityHandle(op));
            return true;
        }

        return false;
    }

    // Issue #421 P2-5: emit a checked numeric narrowing using the
    // overflow-trapping `conv.ovf.*` opcodes. The `_un` variants are
    // selected when the *source* representation is unsigned (the
    // overflow check then treats the input as unsigned and the output
    // as the target's signedness).
    //
    // Floats have no `conv.ovf.r4 / r8`; checked float widening / float
    // → float narrowing is identical to the unchecked form, so we fall
    // back to `conv.r4 / conv.r8` for those targets. Source-is-float
    // narrowings to an integral still get `conv.ovf.*` so a NaN or
    // out-of-range float traps as overflow per ECMA-335.
    private bool TryEmitCheckedNumericConversion(Type from, Type to)
    {
        var sourceUnsigned = IsUnsignedClrType(from);
        ILOpCode? op = null;

        if (to.IsSameAs(typeof(sbyte)))
        {
            op = sourceUnsigned ? ILOpCode.Conv_ovf_i1_un : ILOpCode.Conv_ovf_i1;
        }
        else if (to.IsSameAs(typeof(byte)))
        {
            op = sourceUnsigned ? ILOpCode.Conv_ovf_u1_un : ILOpCode.Conv_ovf_u1;
        }
        else if (to.IsSameAs(typeof(short)))
        {
            op = sourceUnsigned ? ILOpCode.Conv_ovf_i2_un : ILOpCode.Conv_ovf_i2;
        }
        else if (to.IsSameAs(typeof(ushort)) || to.IsSameAs(typeof(char)))
        {
            op = sourceUnsigned ? ILOpCode.Conv_ovf_u2_un : ILOpCode.Conv_ovf_u2;
        }
        else if (to.IsSameAs(typeof(int)))
        {
            // From a same-size signed source the value already fits, but
            // from a same-size unsigned source we still need the check
            // (`uint` → `int` traps for values > Int32.MaxValue).
            if (from.IsSameAs(typeof(int)))
            {
                return true;
            }

            op = sourceUnsigned ? ILOpCode.Conv_ovf_i4_un : ILOpCode.Conv_ovf_i4;
        }
        else if (to.IsSameAs(typeof(uint)))
        {
            if (from.IsSameAs(typeof(uint)))
            {
                return true;
            }

            op = sourceUnsigned ? ILOpCode.Conv_ovf_u4_un : ILOpCode.Conv_ovf_u4;
        }
        else if (to.IsSameAs(typeof(long)))
        {
            // A signed widening (i1/i2/i4 → i8) needs `conv.i8` (not
            // `conv.ovf.i8`) because it can't overflow; the same holds
            // for the identity i8 → i8. An unsigned source widening to
            // long uses `conv.ovf.i8.un` to trap on the >Int64.MaxValue
            // boundary; an unsigned same-size widening (uint → long) is
            // safe but the `_un` variant still trivially succeeds.
            if (from.IsSameAs(typeof(long)))
            {
                return true;
            }

            if (sourceUnsigned)
            {
                op = ILOpCode.Conv_ovf_i8_un;
            }
            else if (from.IsSameAs(typeof(float)) || from.IsSameAs(typeof(double)))
            {
                op = ILOpCode.Conv_ovf_i8;
            }
            else
            {
                // Signed integral widening cannot overflow; emit the
                // plain widening opcode.
                op = ILOpCode.Conv_i8;
            }
        }
        else if (to.IsSameAs(typeof(ulong)))
        {
            if (from.IsSameAs(typeof(ulong)))
            {
                return true;
            }

            op = sourceUnsigned ? ILOpCode.Conv_ovf_u8_un : ILOpCode.Conv_ovf_u8;
        }
        else if (to.IsSameAs(typeof(nint)))
        {
            op = sourceUnsigned ? ILOpCode.Conv_ovf_i_un : ILOpCode.Conv_ovf_i;
        }
        else if (to.IsSameAs(typeof(nuint)))
        {
            op = sourceUnsigned ? ILOpCode.Conv_ovf_u_un : ILOpCode.Conv_ovf_u;
        }
        else if (to.IsSameAs(typeof(float)))
        {
            op = ILOpCode.Conv_r4;
        }
        else if (to.IsSameAs(typeof(double)))
        {
            op = ILOpCode.Conv_r8;
        }

        if (op == null)
        {
            return false;
        }

        this.il.OpCode(op.Value);
        return true;
    }

    // Issue #421 P2-5: enum ⇄ numeric (and enum ⇄ enum). CLR enum
    // storage is identical to the underlying integral, so we route the
    // conversion through the numeric lattice using the underlying type
    // on whichever side carries the enum.
    private bool TryEmitEnumConversion(TypeSymbol from, TypeSymbol to, bool isChecked)
    {
        var fromUnderlying = GetEnumUnderlyingTypeSymbol(from);
        var toUnderlying = GetEnumUnderlyingTypeSymbol(to);

        if (fromUnderlying == null && toUnderlying == null)
        {
            return false;
        }

        var effectiveFrom = fromUnderlying ?? from;
        var effectiveTo = toUnderlying ?? to;

        // If the underlying primitives are identical (e.g. `Color` enum
        // ↔ int32, or one int-backed enum ↔ another int-backed enum)
        // the IL representation is the same and we emit nothing — the
        // i4 already on the stack is the result.
        if (effectiveFrom?.ClrType != null && effectiveTo?.ClrType != null
            && effectiveFrom.ClrType == effectiveTo.ClrType)
        {
            return true;
        }

        return TryEmitNumericConversion(effectiveFrom, effectiveTo, isChecked);
    }

    private void EmitDefault(BoundDefaultExpression node)
    {
        var type = node.Type;

        // Issue #774: a type parameter or erased open generic (e.g. `T` or
        // `List[T]`) may close to either a reference type or a value type
        // at runtime; `ldnull` is invalid for the value-type case. Always
        // route through the slot-based `ldloca; initobj; ldloc` shape — it
        // zero-inits the storage uniformly (null for ref types, zeroed
        // bytes for value types) and IL-verifies for any instantiation.
        // Issue #814 / ADR-0084 §L5: `T?` over an open type parameter
        // (either `[T struct]` or `[T class]`) needs the same treatment —
        // ldnull → !!T is unverifiable even with a `class` constraint, and
        // for `[T struct]` the storage is `Nullable<!!T>` which requires
        // `initobj` to materialise the missing-value sentinel.
        var typeParamLike = type is TypeParameterSymbol
            || (type is ImportedTypeSymbol erasedGen && erasedGen.HasTypeParameterArgument)
            || (type is NullableTypeSymbol nullableTp && nullableTp.UnderlyingType is TypeParameterSymbol);

        // Reference types: ldnull
        if (!typeParamLike && !ReflectionMetadataEmitter.IsValueTypeSymbol(type))
        {
            this.il.OpCode(ILOpCode.Ldnull);
            return;
        }

        // Primitive value types: push zero constant
        if (type == TypeSymbol.Int32 || type == TypeSymbol.Bool)
        {
            this.il.LoadConstantI4(0);
            return;
        }

        // Arbitrary value type (or type-parameter / erased open generic):
        // ldloca temp; initobj T; ldloc temp
        if (!this.defaultExpressionSlots.TryGetValue(node, out var slot))
        {
            throw new InvalidOperationException(
                $"No slot populated for {node.Kind} of value type '{type.Name}' — "
                + "walker pre-pass missed this child? "
                + "Check DefaultExpressionCollector and its ancestor walker.");
        }

        this.il.LoadLocalAddress(slot);
        this.il.OpCode(ILOpCode.Initobj);
        this.il.Token(this.outer.GetElementTypeToken(type));
        this.il.LoadLocal(slot);
    }

    private void EmitClrConversionCall(BoundClrConversionCallExpression conv)
    {
        // Stream E emit parity: user-defined op_Implicit / op_Explicit is a
        // public-static method taking one arg, returning the target type.
        this.EmitExpression(conv.Source);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(conv.Method));
        this.EmitErasedObjectReturnWidening(TypeSymbol.FromClrType(conv.Method.ReturnType), conv.Type);

        // Issue #663: when the operator returns a non-nullable value type T but the
        // target type is Nullable<T> (e.g. op_Explicit(JsonNode) → int, target int32?),
        // lift the result into Nullable<T> via newobj.
        if (conv.Type is NullableTypeSymbol targetNullable
            && ReflectionMetadataEmitter.IsValueTypeNullable(targetNullable)
            && conv.Method.ReturnType.IsValueType
            && !IsNullableValueType(conv.Method.ReturnType))
        {
            var innerClr = targetNullable.UnderlyingType.ClrType
                ?? throw new InvalidOperationException(
                    $"Nullable<{targetNullable.UnderlyingType.Name}> lift has no CLR underlying type.");

            if (!NullableLifting.TryConstructNullable(this.outer.emitCtx.References, innerClr, out var nullableClr))
            {
                throw new InvalidOperationException(
                    $"Cannot construct Nullable<{innerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
            }

            var nullableInnerArg = nullableClr.GetGenericArguments()[0];
            var ctor = nullableClr.GetConstructor(new[] { nullableInnerArg })
                ?? throw new InvalidOperationException(
                    $"Nullable<{nullableInnerArg.FullName}> has no single-arg constructor.");
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(ctor));
        }
    }

    private static bool IsNullableValueType(Type t)
    {
        return t.IsGenericType
            && !t.IsGenericTypeDefinition
            && string.Equals(t.GetGenericTypeDefinition().FullName, "System.Nullable`1", StringComparison.Ordinal);
    }

    private void EmitZeroInit(int slot, TypeSymbol gsharpType, Type clrType)
    {
        if (clrType.IsValueType)
        {
            this.il.LoadLocalAddress(slot);
            this.il.OpCode(ILOpCode.Initobj);
            var initType = gsharpType.ClrType == null
                ? TypeSymbol.FromClrType(clrType)
                : gsharpType;
            this.il.Token(this.outer.GetElementTypeToken(initType));
        }
        else
        {
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.StoreLocal(slot);
        }
    }
}
