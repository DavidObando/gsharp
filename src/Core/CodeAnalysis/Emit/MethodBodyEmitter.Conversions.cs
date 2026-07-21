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
        // ADR-0122 / issue #1014: `nil -> *T` materialises a null pointer as a
        // zero native int. Emit it directly (the source `nil` would otherwise
        // push an object `ldnull`, which is not a verifiable pointer value).
        if (conv.Type is Symbols.PointerTypeSymbol && conv.Expression.Type == TypeSymbol.Null)
        {
            this.il.LoadConstantI4(0);
            this.il.OpCode(ILOpCode.Conv_i);
            return;
        }

        // Issue #1330: a function literal converted to a delegate type closed
        // over an in-scope generic type parameter (e.g. `Comparison[TResult]`,
        // the parameter of `Comparer[TResult].Create(...)`). The target has no
        // usable ClrType (it is the type-erased `Comparison<object>`), so the
        // general CLR-delegate path below cannot reach the constructed shape.
        // Materialise the delegate with a `.ctor` MemberRef parented at the
        // constructed `Comparison<!TResult>` TypeSpec so the runtime instance
        // matches the callee's reified parameter.
        if (conv.Expression.Type is FunctionTypeSymbol constructedDelegateSource
            && conv.Type is ImportedTypeSymbol constructedDelegateTarget
            && constructedDelegateTarget.OpenDefinition != null
            && constructedDelegateTarget.HasSubstitutableTypeArgument
            && ClrTypeUtilities.IsDelegateType(constructedDelegateTarget.ClrType))
        {
            this.EmitFunctionToDelegateConversion(
                conv.Expression,
                constructedDelegateSource,
                constructedDelegateTarget.ClrType,
                this.outer.memberRefs.GetConstructedDelegateCtorRef(constructedDelegateTarget));
            return;
        }

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

        // Issue #1356: a function-typed value `(P...) -> R` flowing into a
        // `(P...) -> R?` slot where the two differ only by a nullable annotation
        // on the return type of the same underlying type (`T -> T?`). The
        // nullable annotation is a binder-level concept only — a
        // NullableTypeSymbol erases to its UnderlyingType.ClrType — so both
        // function types materialise to the identical CLR delegate. The
        // conversion is therefore a representation-preserving no-op: emit the
        // source value unchanged. This is the only path that reaches here for a
        // return type built over a bare type parameter `T`, whose ClrType is
        // null during binding so the concrete CLR-delegate path above cannot
        // fire.
        if (conv.Expression.Type is FunctionTypeSymbol fnNoOpFrom
            && conv.Type is FunctionTypeSymbol fnNoOpTo
            && IsRepresentationPreservingFunctionConversion(fnNoOpFrom, fnNoOpTo))
        {
            this.EmitExpression(conv.Expression);
            return;
        }

        this.EmitExpression(conv.Expression);
        var from = conv.Expression.Type;
        var to = conv.Type;
        if (from == to)
        {
            return;
        }

        // ADR-0122 / issue #1014: unmanaged pointer conversions. Pointer and
        // native-int (`nint`/`nuint`/pointer) share the CLR native-int
        // representation, so pointer<->pointer and pointer<->nint are no-ops.
        // A narrower integer source (`int32`/`uint32`/etc.) is widened to a
        // native int via `conv.i`.
        if (from is Symbols.PointerTypeSymbol || to is Symbols.PointerTypeSymbol)
        {
            var partner = to is Symbols.PointerTypeSymbol ? from : to;
            if (partner == TypeSymbol.NInt || partner == TypeSymbol.NUInt
                || partner is Symbols.PointerTypeSymbol)
            {
                return;
            }

            if (to is Symbols.PointerTypeSymbol)
            {
                this.il.OpCode(ILOpCode.Conv_i);
            }
            else if (to == TypeSymbol.Int64 || to == TypeSymbol.UInt64)
            {
                this.il.OpCode(ILOpCode.Conv_i8);
            }
            else
            {
                this.il.OpCode(ILOpCode.Conv_i4);
            }

            return;
        }

        // Phase 3.C.2 / ADR-0001 (generalized by issue #2354 follow-up): `nil`
        // flows into any reference-typed slot; the IL value is already
        // ldnull. A reference-typed `Nullable<T>` shares the CLR
        // representation of the underlying reference type, so ldnull is a
        // valid value for it too. Likewise a non-nullable G# `class`, an
        // interface, or a reference-constrained type parameter —
        // `Conversion.IsNilAssignableWithoutNullableWrapper` is the single
        // shared (deliberately narrow — see its doc comment) predicate the
        // binder itself now uses (Conversion.Classify) to admit these as
        // implicit `nil ->` conversions, so emission mirrors it exactly
        // rather than re-deriving its own subset. General CLR-backed
        // reference types (`string`, `object`, function/delegate/sequence
        // types) are NOT included — the binder never produces a `nil ->`
        // conversion node for them (they still require an explicit `T?`), so
        // this emit path is never reached for those targets.
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
                || Conversion.IsNilAssignableWithoutNullableWrapper(to)))
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

        // Issue #1298 / #1572: value-type `T → T?` lift where T is a
        // user-declared value type (enum or value-kind struct). The type has no
        // runtime CLR type, so the BCL-backed ctor path below (which closes
        // `Nullable<>` over a real `Type`) cannot fire; instead emit
        // `newobj Nullable<T>::.ctor(!0)` against a TypeSpec parent that closes
        // `Nullable<>` over the type's emitted TypeDef/TypeSpec. Mirrors the
        // open-type-parameter branch in the value-type lift below.
        if (to is NullableTypeSymbol toUserVtNullableLift
            && NullableLifting.IsUserValueTypeNullable(toUserVtNullableLift)
            && from == toUserVtNullableLift.UnderlyingType)
        {
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.memberRefs.GetNullableCtorMemberRefForUserValueType(toUserVtNullableLift));
            return;
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
                this.il.Token(this.outer.memberRefs.GetNullableCtorMemberRefForOpenTypeParameter(toValueNullableLift));
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
            this.il.Token(this.outer.memberRefs.GetCtorReference(ctor));
            return;
        }

        // Issue #1255: lifted nullable reference upcast `T? -> U?` where U is a
        // base class or implemented interface of T. Both sides are reference-
        // type Nullable<T>, which share the underlying reference's CLR
        // representation, so the upcast (and null propagation) is metadata-only —
        // the reference already on the stack is a valid U?. This mirrors the
        // `T -> U?` (#1121) and `T -> U` reference upcasts as a no-op.
        if (from is NullableTypeSymbol fromRefNullable
            && to is NullableTypeSymbol toRefNullable
            && !ReflectionMetadataEmitter.IsValueTypeNullable(fromRefNullable)
            && !ReflectionMetadataEmitter.IsValueTypeNullable(toRefNullable)
            && IsReferenceCompatible(fromRefNullable.UnderlyingType, toRefNullable.UnderlyingType))
        {
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
            && !ReflectionMetadataEmitter.IsValueTypeSymbol(from)
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
        // Restricted to a non-nullable source — a Nullable<T1> source is a lifted
        // conversion handled by the dedicated #1236 arm below (TryEmitNumericConversion
        // would otherwise read the source's ClrType as its bare underlying and
        // emit a conv.* against the Nullable<T1> struct value on the stack).
        if (from is not NullableTypeSymbol
            && to is NullableTypeSymbol toValueNullableWiden
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
            this.il.Token(this.outer.memberRefs.GetCtorReference(widenCtor));
            return;
        }

        // Issue #1236: lifted numeric widening between two distinct value-type
        // `Nullable<T>` operands (e.g. `uint8? → int32?`, `int32? → int64?`).
        // The source struct is already on the stack; spill it, branch on
        // HasValue, and either re-wrap the converted underlying value as a fresh
        // `Nullable<T2>` (HasValue == true) or materialise default(Nullable<T2>)
        // (HasValue == false). Two consecutive scratch slots — the source
        // `Nullable<T1>` and the result `Nullable<T2>` — are pre-allocated by
        // the planner (CollectNullableNumericWideningConversions) and keyed in
        // receiverSpillSlots by this conversion node (dest = source + 1).
        if (from is NullableTypeSymbol fromValueNullableLift
            && ReflectionMetadataEmitter.IsValueTypeNullable(fromValueNullableLift)
            && to is NullableTypeSymbol toValueNullableLift2
            && ReflectionMetadataEmitter.IsValueTypeNullable(toValueNullableLift2)
            && fromValueNullableLift.UnderlyingType != toValueNullableLift2.UnderlyingType)
        {
            this.EmitLiftedNullableNumericWidening(conv, fromValueNullableLift, toValueNullableLift2);
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
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(from));
            return;
        }

        // Issue #1218: a value-type value (notably an enum) converting to one of
        // its CLR reference base types — System.ValueType or System.Enum — boxes
        // to a proper object reference. This mirrors the `object`/interface box
        // above and lets inherited Enum/ValueType members receive the boxed
        // receiver/argument (e.g. an enum passed to System.Enum.HasFlag).
        if (ReflectionMetadataEmitter.IsValueTypeSymbol(from)
            && to?.ClrType is System.Type valueBoxTarget
            && (valueBoxTarget.IsSameAs(typeof(System.ValueType))
                || valueBoxTarget.IsSameAs(typeof(System.Enum))))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(from));
            return;
        }

        // ADR-0087 §3 R4: after R2 a value of `T` lives in a real type slot
        // (VAR/MVAR), not an erased `object`. Where the binder still emits a
        // BoundConversionExpression bridging `T → object` (e.g. passing a
        // generic value to a non-reified delegate parameter still bound as
        // `object`), emit `box T` so the JIT materialises the value-or-
        // reference boxed slot. The JIT elides the box when T resolves to a
        // reference type at runtime, so no perf regression.
        //
        // Issue #1455: the same widening reaches emit through a NULLABLE
        // wrapper over the type parameter (`T?`) — e.g. a lambda whose body
        // returns `T?` flowing into a `Func<..., object>` parameter via
        // delegate-return covariance, or `Task.FromResult(default)` over
        // `T?`. `T?` shares `T`'s CLR representation for a ref-constrained or
        // unconstrained `T` (`box !!T`), and is `Nullable<!!T>` for a
        // value-type-constrained `T` (`box Nullable<!!T>` correctly yields a
        // null reference for the missing-value case). `GetElementTypeToken`
        // already selects the right token for the nullable wrapper in either
        // constraint case, so we box the wrapper symbol directly.
        if ((from is TypeParameterSymbol
                || (from is NullableTypeSymbol fromNullableTp && fromNullableTp.UnderlyingType is TypeParameterSymbol))
            && (to?.ClrType.IsSameAs(typeof(object)) == true || IsInterfaceTargetType(to)))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(from));
            return;
        }

        // ADR-0045 explicit unbox: `(T)objectValue` for a value type T.
        // Issue #421 P2-5: also fire when the source is an interface
        // reference (user-declared `InterfaceSymbol` or any CLR
        // interface), since a boxed value type held in an interface
        // slot needs `unbox.any` to surface as its native value type.
        // Issue #2492: nullable object/interface annotations are still
        // reference slots, and a nullable value-type target must retain its
        // wrapper token so `unbox.any Nullable<T>` propagates null while
        // preserving checked unboxing semantics for non-null values.
        if (IsExplicitUnboxingSourceType(from)
            && ((to is NullableTypeSymbol nullableUnboxTarget
                    && NullableLifting.IsAnyValueTypeNullable(nullableUnboxTarget))
                || (to is not NullableTypeSymbol
                    && ReflectionMetadataEmitter.IsValueTypeSymbol(to))))
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(to));
            return;
        }

        // Issue #1455 (symmetric direction): `object`/interface → type
        // parameter, including a nullable wrapper over one (`T?`). The boxed
        // reference held in the `object`/interface slot is surfaced with
        // `unbox.any T` (or `unbox.any Nullable<!!T>`). The JIT picks the
        // value-vs-reference shape from the instantiated `T` at call time, so
        // this verifies for any closing instantiation. `GetElementTypeToken`
        // resolves the correct token for both the bare and nullable-wrapped
        // type parameter.
        if (IsExplicitUnboxingSourceType(from)
            && (to is TypeParameterSymbol
                || (to is NullableTypeSymbol toNullableTp && toNullableTp.UnderlyingType is TypeParameterSymbol)))
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(to));
            return;
        }

        if (from?.ClrType.IsSameAs(typeof(object)) == true
            && to?.ClrType.IsSameAs(typeof(object)) == false
            && to is not TypeParameterSymbol
            && !ReflectionMetadataEmitter.IsValueTypeSymbol(to))
        {
            this.il.OpCode(ILOpCode.Castclass);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(to));
            return;
        }

        // Issue #2130: expression-tree lowering builds the lambda node with the
        // non-generic Expression.Lambda(Type, ...) overload, whose static type
        // is LambdaExpression. The runtime instance is the exact
        // Expression<TDelegate> subtype requested by the supplied delegate
        // Type, so the synthesized final step is an explicit reference cast
        // from LambdaExpression to Expression<TDelegate>.
        if (from?.ClrType?.FullName == "System.Linq.Expressions.LambdaExpression"
            && to?.ClrType != null
            && to.ClrType.IsGenericType
            && string.Equals(
                (to.ClrType.IsGenericTypeDefinition ? to.ClrType : to.ClrType.GetGenericTypeDefinition()).FullName,
                "System.Linq.Expressions.Expression`1",
                StringComparison.Ordinal))
        {
            this.il.OpCode(ILOpCode.Castclass);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(to));
            return;
        }

        // Issue #2519: box a class-constrained type parameter when widening it
        // to the constraint, one of its bases, or an implemented interface.
        // For a reference-type instantiation `box !T` is a runtime no-op, while
        // giving the verifier the constrained reference shape it requires.
        if (from is TypeParameterSymbol classConstrainedParameter
            && classConstrainedParameter.ClassConstraint is TypeSymbol classConstraint
            && IsReferenceCompatible(classConstraint, to))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(classConstrainedParameter));
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
            this.il.Token(this.outer.memberRefs.GetMethodReference(userConvMethod));
            return;
        }

        // Issue #1441: `string(charArray)` — the G# rendering of C#
        // `new string(char[])`. The binder accepts a `[]char -> string`
        // conversion, but there is no primitive IL cast for it; materialise it
        // through the `System.String(char[])` constructor. Resolving the ctor
        // from `to.ClrType` (rather than `typeof(string)`) keeps it in the
        // active reference context (live host vs MetadataLoadContext).
        if (to?.ClrType != null && to.ClrType.IsSameAs(typeof(string))
            && from?.ClrType is { IsArray: true } fromArray
            && fromArray.GetElementType() is System.Type fromElement
            && fromElement.IsSameAs(typeof(char)))
        {
            var stringCtor = to.ClrType.GetConstructor(new[] { fromArray });
            if (stringCtor != null)
            {
                this.il.OpCode(ILOpCode.Newobj);
                this.il.Token(this.outer.memberRefs.GetCtorReference(stringCtor));
                return;
            }
        }

        throw new NotSupportedException(
            $"Conversion from '{from.Name}' to '{to.Name}' is not yet supported by the emitter.");
    }

    // Issues #1356/#2542/#2618: reference nullability erases from parameter and
    // return slots, and Func's return slot is CLR-covariant for reference
    // upcasts. These conversions are representation-preserving no-ops.
    private static bool IsRepresentationPreservingFunctionConversion(
        FunctionTypeSymbol from,
        FunctionTypeSymbol to)
    {
        if (from.Arity != to.Arity)
        {
            return false;
        }

        for (var i = 0; i < from.Arity; i++)
        {
            if (!HaveSameReferenceRepresentation(from.ParameterTypes[i], to.ParameterTypes[i]))
            {
                return false;
            }
        }

        if (from.ReturnType == to.ReturnType)
        {
            return true;
        }

        if (to.ReturnType is NullableTypeSymbol toNullableReturn
            && toNullableReturn.UnderlyingType == from.ReturnType)
        {
            return true;
        }

        if (!Conversion.IsReferenceLikeTarget(from.ReturnType)
            || !Conversion.IsReferenceLikeTarget(to.ReturnType))
        {
            return false;
        }

        var returnConversion = Conversion.ClassifyNonStructural(from.ReturnType, to.ReturnType);
        return returnConversion.Exists && returnConversion.IsImplicit;
    }

    private static bool HaveSameReferenceRepresentation(TypeSymbol left, TypeSymbol right)
    {
        while (left is NullabilityAnnotatedTypeSymbol leftAnnotated)
        {
            left = leftAnnotated.BaseType;
        }

        while (right is NullabilityAnnotatedTypeSymbol rightAnnotated)
        {
            right = rightAnnotated.BaseType;
        }

        if (left is NullableTypeSymbol leftReferenceNullable
            && Conversion.IsReferenceLikeTarget(leftReferenceNullable.UnderlyingType))
        {
            left = leftReferenceNullable.UnderlyingType;
        }

        if (right is NullableTypeSymbol rightReferenceNullable
            && Conversion.IsReferenceLikeTarget(rightReferenceNullable.UnderlyingType))
        {
            right = rightReferenceNullable.UnderlyingType;
        }

        if (left == right)
        {
            return true;
        }

        if (!Conversion.IsReferenceLikeTarget(left) || !Conversion.IsReferenceLikeTarget(right))
        {
            return false;
        }

        return Conversion.ClassifyNonStructural(left, right).IsImplicit
            && Conversion.ClassifyNonStructural(right, left).IsImplicit;
    }

    // Issue #1236: emit a lifted numeric widening between two distinct value-type
    // `Nullable<T>` operands. On entry the source `Nullable<T1>` value is already
    // on the stack. Uses two consecutive planner scratch slots (source, result)
    // keyed in receiverSpillSlots by the conversion node.
    private void EmitLiftedNullableNumericWidening(
        BoundConversionExpression conv,
        NullableTypeSymbol fromNullable,
        NullableTypeSymbol toNullable)
    {
        if (!this.receiverSpillSlots.TryGetValue(conv, out var srcSlot))
        {
            throw new InvalidOperationException(
                "No scratch slot pre-allocated for lifted Nullable<T1> -> Nullable<T2> numeric widening — "
                + "check CollectNullableNumericWideningConversions and the prepass in CollectLocalsAndLabels.");
        }

        var dstSlot = srcSlot + 1;

        var fromUnderlying = fromNullable.UnderlyingType;
        var toUnderlying = toNullable.UnderlyingType;
        var fromUnderlyingClr = fromUnderlying.ClrType
            ?? throw new InvalidOperationException(
                $"Lifted Nullable<{fromUnderlying.Name}> widening: source underlying has no CLR type.");
        var toUnderlyingClr = toUnderlying.ClrType
            ?? throw new InvalidOperationException(
                $"Lifted Nullable<{toUnderlying.Name}> widening: target underlying has no CLR type.");

        if (!NullableLifting.TryConstructNullable(this.outer.emitCtx.References, toUnderlyingClr, out var toNullableClr))
        {
            throw new InvalidOperationException(
                $"Cannot construct Nullable<{toUnderlyingClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
        }

        var toNullableInnerArg = toNullableClr.GetGenericArguments()[0];
        var toCtor = toNullableClr.GetConstructor(new[] { toNullableInnerArg })
            ?? throw new InvalidOperationException(
                $"Nullable<{toNullableInnerArg.FullName}> has no single-arg constructor.");
        var toNullableToken = this.outer.memberRefs.GetTypeHandleForMember(toNullableClr);

        var getHasValue = this.outer.wellKnown.GetNullableGetHasValueReference(fromUnderlyingClr);
        var getValueOrDefault = this.outer.wellKnown.GetNullableGetValueOrDefaultReference(fromUnderlyingClr);

        var nullBranch = this.il.DefineLabel();
        var end = this.il.DefineLabel();

        // Spill the source Nullable<T1> and branch on HasValue.
        this.il.StoreLocal(srcSlot);
        this.il.LoadLocalAddress(srcSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getHasValue);
        this.il.Branch(ILOpCode.Brfalse, nullBranch);

        // Present: unwrap, convert the underlying value, re-wrap as Nullable<T2>.
        this.il.LoadLocalAddress(srcSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(getValueOrDefault);
        this.TryEmitNumericConversion(fromUnderlying, toUnderlying, conv.IsChecked);
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.memberRefs.GetCtorReference(toCtor));
        this.il.Branch(ILOpCode.Br, end);

        // Absent: materialise default(Nullable<T2>).
        this.il.MarkLabel(nullBranch);
        this.il.LoadLocalAddress(dstSlot);
        this.il.OpCode(ILOpCode.Initobj);
        this.il.Token(toNullableToken);
        this.il.LoadLocal(dstSlot);

        this.il.MarkLabel(end);
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
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(expectedTp));
            return;
        }

        if (TypeSymbol.ContainsTypeParameter(expectedType))
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(expectedType));
            return;
        }

        if (ReflectionMetadataEmitter.IsValueTypeSymbol(expectedType))
        {
            this.il.OpCode(ILOpCode.Unbox_any);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(expectedType));
            return;
        }

        this.il.OpCode(ILOpCode.Castclass);
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(expectedType));
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
        else if (to.IsSameAs(typeof(long)) || to.IsSameAs(typeof(ulong))
            || to.IsSameAs(typeof(nint)) || to.IsSameAs(typeof(nuint)))
        {
            // ECMA-335: widening to a 64-bit/native-int slot must
            // sign-extend or zero-extend based on the SOURCE's
            // signedness, not the target's. `uint32 -> int64` needs
            // `conv.u8` (zero-extend); `int32 -> uint64` needs
            // `conv.i8` (sign-extend). Float sources have no signedness
            // distinction, so those keep the target-based opcode.
            var fromFloat = from.IsSameAs(typeof(float)) || from.IsSameAs(typeof(double));
            var useUnsigned = fromFloat
                ? (to.IsSameAs(typeof(ulong)) || to.IsSameAs(typeof(nuint)))
                : IsUnsignedClrType(from);

            if (to.IsSameAs(typeof(long)) || to.IsSameAs(typeof(ulong)))
            {
                op = useUnsigned ? ILOpCode.Conv_u8 : ILOpCode.Conv_i8;
            }
            else
            {
                op = useUnsigned ? ILOpCode.Conv_u : ILOpCode.Conv_i;
            }
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

            this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(op));
            return true;
        }

        // From decimal: every numeric target has an `op_Explicit`.
        if (from.IsSameAs(typeof(decimal)))
        {
            // `System.Decimal` declares many `op_Explicit(decimal)`
            // overloads that differ ONLY by return type (decimal -> byte,
            // sbyte, short, ushort, int, uint, long, ulong, float, double,
            // char). `Type.GetMethod(name, Type[])` matches by parameter
            // signature alone and would throw `AmbiguousMatchException`, so
            // we must disambiguate by BOTH parameter and return type by
            // iterating the operator overloads ourselves.
            MethodInfo op = null;
            foreach (var m in typeof(decimal).GetMethods())
            {
                if (m.Name == "op_Explicit"
                    && m.ReturnType.IsSameAs(to)
                    && m.GetParameters().Length == 1
                    && m.GetParameters()[0].ParameterType.IsSameAs(typeof(decimal)))
                {
                    op = m;
                    break;
                }
            }

            if (op == null)
            {
                return false;
            }

            this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(op));
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
        //
        // Issue #1714: `string`'s Go-style `""` zero value applies only to
        // *uninitialized storage* (map-miss reads, struct/class instance
        // fields, auto-property backing fields) — not to the explicit
        // `default`/`default(string)` *expression*, which keeps its
        // pre-existing, intentionally-tested CLR-null semantics (see
        // Issue1391 generic-arg default, Issue1496 bare `default` in a
        // string-returning if-arm, and ADR-0100's EvaluateDefaultExpression
        // short-circuit for reference types). So `string` falls straight
        // through to the ordinary reference-type `ldnull` here.
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
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(type));

        // Issue #1714: `initobj` zero-inits every field to its CLR default,
        // which is `null` for a `string` field — diverging from the
        // interpreter's DefaultValue(StructSymbol), which recursively
        // defaults each field, including fields nested inside a struct-typed
        // field (so a string field becomes `""` at any nesting depth). Patch
        // up any string field reachable from `structDefaultType` through a
        // chain of struct-typed fields (walking the base-class chain at each
        // level, same order as the interpreter) so `default(MyStruct)`
        // agrees with the interpreter for structs with no explicit field
        // initializer left unhandled by BuildInstanceFieldInitializerStatements
        // / ExpressionBinder.Literals's struct-literal fold. Skipped for
        // generic struct instantiations (at any depth) — those fields are
        // erased at this point and not resolvable via the plain FieldDef map;
        // the existing (pre-#1714) CLR-default behavior is unchanged for them.
        if (type is StructSymbol structDefaultType && !ReflectionMetadataEmitter.IsUserGenericTypeReference(structDefaultType))
        {
            this.EmitDefaultStructStringFieldPatches(structDefaultType, slot, new List<EntityHandle>(), depth: 0);
        }

        this.il.LoadLocal(slot);
    }

    /// <summary>
    /// Issue #1714: recursively walks <paramref name="structType"/>'s fields
    /// (base-class chain first, same order as
    /// <c>Evaluator.DefaultValue(StructSymbol)</c>) and, for every `string`
    /// field found — at any nesting depth reachable through a chain of
    /// struct-typed fields — emits an address load for the local at
    /// <paramref name="slot"/> followed by an `ldflda` for each intermediate
    /// struct-typed field in <paramref name="fieldAddressChain"/>, then
    /// `stfld`'s the empty-string literal into the (possibly nested) string
    /// field. A struct value type cannot contain itself by value (the
    /// compiler rejects such declarations), so unbounded recursion isn't
    /// reachable in practice; <paramref name="depth"/> is a defensive cap
    /// guarding against that invariant ever being violated.
    /// </summary>
    private void EmitDefaultStructStringFieldPatches(StructSymbol structType, int slot, List<EntityHandle> fieldAddressChain, int depth)
    {
        const int maxDepth = 64;
        if (depth >= maxDepth)
        {
            return;
        }

        for (var t = structType; t != null; t = t.BaseClass)
        {
            foreach (var field in t.Fields)
            {
                if (field.Type == TypeSymbol.String)
                {
                    if (!this.outer.cache.StructFieldDefs.TryGetValue(field, out var stringFieldHandle))
                    {
                        continue;
                    }

                    this.il.LoadLocalAddress(slot);
                    foreach (var intermediate in fieldAddressChain)
                    {
                        this.il.OpCode(ILOpCode.Ldflda);
                        this.il.Token(intermediate);
                    }

                    this.il.LoadString(this.outer.emitCtx.Metadata.GetOrAddUserString(string.Empty));
                    this.il.OpCode(ILOpCode.Stfld);
                    this.il.Token(stringFieldHandle);
                }
                else if (field.Type is StructSymbol nestedStruct
                    && ReflectionMetadataEmitter.IsValueTypeSymbol(nestedStruct)
                    && !ReflectionMetadataEmitter.IsUserGenericTypeReference(nestedStruct)
                    && this.outer.cache.StructFieldDefs.TryGetValue(field, out var nestedFieldHandle))
                {
                    fieldAddressChain.Add(nestedFieldHandle);
                    this.EmitDefaultStructStringFieldPatches(nestedStruct, slot, fieldAddressChain, depth + 1);
                    fieldAddressChain.RemoveAt(fieldAddressChain.Count - 1);
                }
            }
        }
    }

    /// <summary>
    /// Issue #988: emits the construction of a type parameter `T` that carries a
    /// `new()` constraint — the G# spelling `T()`. Lowered to a reified
    /// `call !!0 [System.Runtime]System.Activator::CreateInstance&lt;!!T&gt;()`
    /// (ADR-0087). `Activator.CreateInstance&lt;T&gt;()` is the standard C#
    /// `new()`-constraint lowering and yields a real instance for both reference
    /// types with a public parameterless ctor and value types.
    /// </summary>
    private void EmitTypeParameterConstruction(BoundTypeParameterConstructionExpression node)
    {
        var openCreateInstance = typeof(System.Activator)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == "CreateInstance"
                && m.IsGenericMethodDefinition
                && m.GetGenericArguments().Length == 1
                && m.GetParameters().Length == 0);

        // Close the open definition with a placeholder; GetMethodEntityHandle
        // re-encodes the real type argument (the in-scope type parameter, a
        // VAR/MVAR) into the MethodSpec via the symbolic-argument path.
        var closed = openCreateInstance.MakeGenericMethod(typeof(object));
        var handle = this.outer.memberRefs.GetMethodEntityHandle(
            closed,
            ImmutableArray.Create<TypeSymbol>(node.TypeParameter));

        this.il.OpCode(ILOpCode.Call);
        this.il.Token(handle);
    }

    private void EmitClrConversionCall(BoundClrConversionCallExpression conv)
    {
        // Stream E emit parity: user-defined op_Implicit / op_Explicit is a
        // public-static method taking one arg, returning the target type.
        this.EmitExpression(conv.Source);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.memberRefs.GetMethodReference(conv.Method));
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
            this.il.Token(this.outer.memberRefs.GetCtorReference(ctor));
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
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(initType));
        }
        else
        {
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.StoreLocal(slot);
        }
    }
}
