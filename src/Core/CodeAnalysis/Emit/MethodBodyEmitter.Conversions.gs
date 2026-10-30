// <copyright file="MethodBodyEmitter.Conversions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Diagnostics
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// PR-E-11 partial of (cref:MethodBodyEmitter):
/// conversion IL emission (absorbed from PR-E-5 Option B).
/// See `MethodBodyEmitter.cs` for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
internal partial class MethodBodyEmitter {
    private func EmitConversion(conv BoundConversionExpression) {
        // ADR-0122 / issues #1014, #3268, and #3285: `nil` materialises a null
        // pointer as a zero native int. Emit it directly (the source `nil`
        // would otherwise push an object `ldnull`, which is not a pointer
        // value).
        if conv.Expression.Type == TypeSymbol.Null && this.TryEmitPointerLikeDefault(conv.Type) {
            return
        }
        if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(conv.Expression.Type, conv.Type) &&
            !RequiresChannelConversionEmission(conv.Expression.Type, conv.Type) {
            this.EmitExpression(conv.Expression)
            return
        }
        if NativeProtocolOperations.GetProtocol(conv.Expression.Type) != nil && NativeProtocolOperations.GetProtocol(
            conv.Type
        ) is {} targetProtocol {
            this.EmitExpression(conv.Expression)
            this.il.OpCode(ILOpCode.Castclass)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(targetProtocol))
            return
        }
        // ADR-0174 D2: the channel lattice. Same direction is identity at the
        // IL level (`Chan<T>` IS a `Channel<T>`; a foreign `ChannelReader<T>`
        // IS an `in chan[T]`). Narrowing a bidirectional handle to a
        // directional one fetches the reader/writer view.
        //
        // Both operands go through the one recognizer. Issue #3958: it looks
        // through a nullable wrapper, so an `out chan[T]?` target lands here —
        // every channel shape is a class, so the wrapper is a binder-level
        // annotation over an identical CLR representation, which is why
        // `TryClassifyChannelConversion` declines a nullable operand and leaves
        // the pair to the lifted rules. Issue #3976: it also recognizes the
        // IMPORTED spellings, so a target that came back from metadata as
        // `ChannelWriter<T>`/`ChannelReader<T>`/`Channel<T>` — which is every
        // channel in another assembly's signature — reaches the view emission
        // instead of the unsupported-conversion throw below. Testing the target
        // for `is ChannelTypeSymbol` asked which NAME the author wrote; the
        // classifier no longer asks that, and neither does this.
        if ChannelTypeSymbol.TryGetChannelShape(
            conv.Type,
            out var targetElement,
            out var targetDirection,
            out var targetConstructed
        ) &&
            ChannelTypeSymbol
            .TryGetChannelShape(conv.Expression.Type, out _, out var sourceDirection, out var sourceConstructed) {
            this.EmitExpression(conv.Expression)
            if sourceDirection == targetDirection {
                if targetConstructed && !sourceConstructed {
                    this.il.OpCode(ILOpCode.Castclass)
                    this.il.Token(this.outer.memberRefs.GetElementTypeToken(conv.Type))
                }
                return
            }
            let elementClr = ResolveChannelElementClrType(targetElement!!)
            let channelClr = typeof(System.Threading.Channels.Channel[_]).MakeGenericType(elementClr)
            let view = BclMember.Getter(
                channelClr,
                if targetDirection == ChannelDirection.In {
                    "Reader"
                } else {
                    "Writer"
                }
            )
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.GetChannelMethodEntityHandle(view, targetElement!!))
            return
        }
        // Issue #2840 / #2841: a nullable wrapper over a REFERENCE type is a
        // binder-level annotation only — it erases to the underlying type's CLR
        // representation — so the delegate-materialisation arms below classify
        // on the unwrapped views. Both a structural function type and a named
        // delegate are unconditionally reference types (each materialises as a
        // delegate instance), so `((P…) -> R)?` and `D?` share the identical
        // representation with their bare forms. Genuine `Nullable<T>` value
        // shapes are left wrapped and fall through to the value-type arms
        // further down. The null-guarded adaptation helpers already tolerate a
        // null source, so a possibly-null function value stays correct.
        let delegateSourceType = UnwrapReferenceNullable(conv.Expression.Type)
        let delegateTargetType = UnwrapReferenceNullable(conv.Type)
        // Issue #5536: a function value or method group keeps its delegate. The binder admits it only when
        // `Conversion.KeepsFunctionValueDelegate` holds, or for an explicit checked cast. A checked cast is
        // `castclass`, which keeps the reference or throws. A value that is already a valid target reference needs
        // no IL. A method group is bound to the target delegate by the arms below.
        if delegateSourceType is FunctionTypeSymbol && !(conv.Expression is BoundFunctionLiteralExpression) {
            if !Conversion.KeepsFunctionValueDelegate(conv.Expression.Type, conv.Type) {
                if !Conversion.HasCheckedReferenceConversion(conv.Expression.Type, conv.Type) ||
                    !Conversion
                    .ChecksFunctionValueDelegate(conv.Expression.Type, conv.Type) {
                    throw InvalidOperationException(
                        "Conversion from '${conv.Expression.Type.Name}' to '${conv.Type.Name}' needs a function literal."
                    )
                }
                this.EmitExpression(conv.Expression)
                this.il.OpCode(ILOpCode.Castclass)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(delegateTargetType))
                return
            }
            if !(conv.Expression is BoundMethodGroupExpression || conv.Expression is BoundClrMethodGroupExpression) &&
                Conversion
                .ReusesFunctionValueDelegate(delegateSourceType, delegateTargetType) {
                this.EmitExpression(conv.Expression)
                return
            }
        }
        // Issue #1330: a function literal converted to a delegate type closed
        // over an in-scope generic type parameter (e.g. `Comparison[TResult]`,
        // the parameter of `Comparer[TResult].Create(...)`). The target has no
        // usable ClrType (it is the type-erased `Comparison<object>`), so the
        // general CLR-delegate path below cannot reach the constructed shape.
        // Materialise the delegate with a `.ctor` MemberRef parented at the
        // constructed `Comparison<!TResult>` TypeSpec so the runtime instance
        // matches the callee's reified parameter.
        if delegateSourceType is FunctionTypeSymbol constructedDelegateSource &&
            delegateTargetType is ImportedTypeSymbol constructedDelegateTarget &&
            constructedDelegateTarget.OpenDefinition != nil &&
            constructedDelegateTarget.HasSubstitutableTypeArgument &&
            ClrTypeUtilities
            .IsDelegateType(constructedDelegateTarget.ClrType) {
            this.EmitFunctionToDelegateConversion(
                conv.Expression,
                constructedDelegateSource,
                Invariant.Required(
                    constructedDelegateTarget.ClrType,
                    "a constructed delegate has a CLR representation",
                    expression: "constructedDelegateTarget.ClrType"
                ),
                this.outer.memberRefs.GetConstructedDelegateCtorRef(constructedDelegateTarget)
            )
            return
        }
        // ADR-0059 / issue #255: GSharp function value → user-declared
        // named delegate type. The named delegate has no ClrType (its
        // TypeDef only exists in the assembly being emitted), so the
        // CLR-delegate path below cannot fire; emit the same
        // `ldnull/ldftn/newobj` (or closure `dup/ldftn/newobj`) sequence
        // but referencing the delegate's emitted ctor MethodDef handle
        // instead of a CLR ConstructorInfo.
        //
        // Issue #2841: a `D?` target reaches here too. A nullable wrapper over
        // a REFERENCE type is a binder-level annotation that erases to the
        // underlying type's CLR representation, and a named delegate is always
        // a reference type (a sealed class deriving from
        // `System.MulticastDelegate`), so the materialisation is byte-identical
        // to the bare-`D` case.
        if delegateSourceType is FunctionTypeSymbol namedSourceFn &&
            delegateTargetType is DelegateTypeSymbol namedTargetDelegate {
            this.EmitFunctionToNamedDelegateConversion(conv.Expression, namedSourceFn, namedTargetDelegate)
            return
        }
        // Issue #2672: an erased-lambda adapter can receive an imported named
        // delegate while its original body expects the equivalent structural
        // function. Rebuild the value over the named delegate's Invoke target
        // so the adapter body and its outer delegate constructor both verify.
        if delegateTargetType is FunctionTypeSymbol delegateTargetFn &&
            delegateSourceType is ImportedTypeSymbol{ClrType: Type importedDelegateSource} &&
            ClrTypeUtilities
            .IsDelegateType(importedDelegateSource) {
            let invoke = importedDelegateSource.GetMethod("Invoke") ??
                throw InvalidOperationException(
                "Delegate type '${importedDelegateSource.FullName}' has no Invoke method."
            )
            let ctor = if this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(delegateTargetFn) {
                this.outer.memberRefs.GetFunctionDelegateCtorRef(delegateTargetFn)
            } else {
                EntityHandle(
                    this
                        .outer
                        .memberRefs
                        .GetDelegateCtorReference(this.outer.signatures.ResolveDelegateClrType(delegateTargetFn))
                )
            }
            this.EmitNullGuardedDelegateToDelegateAdaptation(
                conv.Expression,
                this.outer.memberRefs.GetMethodReference(invoke),
                ctor
            )
            return
        }
        // Issue #295: GSharp function value → CLR delegate. This is the
        // general materialization that previously only happened in
        // argument position; routing it through EmitConversion makes
        // assignment, return, and cast positions emit the same delegate
        // instantiation IL.
        if delegateSourceType is FunctionTypeSymbol sourceFn &&
            delegateTargetType?.ClrType != nil &&
            ClrTypeUtilities
            .IsDelegateType(delegateTargetType.ClrType) {
            this.EmitFunctionToDelegateConversion(conv.Expression, sourceFn, delegateTargetType.ClrType!!)
            return
        }
        // Issues #1356/#2542/#2618: reference nullability and reference variance
        // keep the delegate. A method group gets its natural delegate here,
        // which is already a valid target reference.
        if delegateSourceType is FunctionTypeSymbol &&
            delegateTargetType is FunctionTypeSymbol &&
            Conversion
            .ReusesFunctionValueDelegate(delegateSourceType, delegateTargetType) {
            this.EmitExpression(conv.Expression)
            return
        }
        this.EmitExpression(conv.Expression)
        var from = conv.Expression.Type
        var to = conv.Type
        if from == to {
            return
        }
        // ADR-0186 §1: `T!` erases to `T` at emit, and — unlike `T?` — has no
        // value-type case to lower (§2: no `int32!`), so every arm below sees
        // the conversion between the underlying types. `nil -> T!` is first
        // answered on the wrapper, because stripping it would leave
        // `nil -> string`, which the nil arm below (deliberately narrow) does
        // not admit. Before ADR-0186 §9 a platform wrapper only ever reached
        // here over an imported type, whose `ClrType` let the CLR arms below
        // cope; a G#-declared class, interface or delegate under one
        // (`Derived! -> Base!`, `Dog -> Animal!`, a lambda to `Predicate!`)
        // fell through to the unsupported-conversion throw.
        if from == TypeSymbol.Null && to is PlatformTypeSymbol {
            return
        }
        from = PlatformTypeSymbol.StripTopLevel(from)
        to = PlatformTypeSymbol.StripTopLevel(to)
        if from == to {
            return
        }
        // ADR-0122 / issue #1014: unmanaged pointer conversions. Pointer and
        // native-int (`nint`/`nuint`/pointer) share the CLR native-int
        // representation, so pointer<->pointer and pointer<->nint are no-ops.
        // A narrower integer source (`int32`/`uint32`/etc.) is widened to a
        // native int via `conv.i`.
        if from is PointerTypeSymbol || to is PointerTypeSymbol {
            let partner = if to is PointerTypeSymbol {
                from
            } else {
                to
            }
            if partner == TypeSymbol.NInt || partner == TypeSymbol.NUInt || partner is PointerTypeSymbol {
                return
            }
            if to is PointerTypeSymbol {
                this.il.OpCode(ILOpCode.Conv_i)
            } else if to == TypeSymbol.Int64 || to == TypeSymbol.UInt64 {
                this.il.OpCode(ILOpCode.Conv_i8)
            } else {
                this.il.OpCode(ILOpCode.Conv_i4)
            }
            return
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
        // (ADR-0186 §3's `nil -> T!` row is answered above, before the
        // platform wrapper is stripped.)
        if from == TypeSymbol.Null &&
            (
            (to is NullableTypeSymbol toNullForNil && !ReflectionMetadataEmitter.IsValueTypeNullable(toNullForNil)) ||
                Conversion.IsNilAssignableWithoutNullableWrapper(to)
        ) {
            return
        }
        if from == TypeSymbol.Null &&
            to is NullableTypeSymbol toValueNullForNil &&
            ReflectionMetadataEmitter
            .IsValueTypeNullable(toValueNullForNil) {
            throw InvalidOperationException(
                "Conversion 'nil' -> '${to.Name}' (a value-type Nullable) must be lowered to a " +
                    "BoundDefaultExpression by the binder so emit can allocate a temp slot for " +
                    "ldloca/initobj/ldloc. Reaching EmitConversion indicates a missing lowering path."
            )
        }
        // Issue #1298 / #1572: value-type `T → T?` lift where T is a
        // user-declared value type (enum or value-kind struct). The type has no
        // runtime CLR type, so the BCL-backed ctor path below (which closes
        // `Nullable<>` over a real `Type`) cannot fire; instead emit
        // `newobj Nullable<T>::.ctor(!0)` against a TypeSpec parent that closes
        // `Nullable<>` over the type's emitted TypeDef/TypeSpec. Mirrors the
        // open-type-parameter branch in the value-type lift below.
        if to is NullableTypeSymbol toUserVtNullableLift && NullableLifting.RequiresSymbolicNullableGetValue(
            toUserVtNullableLift
        ) &&
            Conversion
            .ClassifyNonStructural(from, toUserVtNullableLift.UnderlyingType).IsIdentity {
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(
                if toUserVtNullableLift.UnderlyingType is TypeParameterSymbol {
                    this.outer.memberRefs.GetNullableCtorMemberRefForOpenTypeParameter(toUserVtNullableLift)
                } else {
                    this.outer.memberRefs.GetNullableCtorMemberRefForUserValueType(toUserVtNullableLift)
                }
            )
            return
        }
        // Issue #504: value-type `T → Nullable<T>` is a true CLR widening;
        // emit `newobj Nullable<T>::.ctor(T)`. This must run before the
        // reference-compatibility shortcut below, which would otherwise
        // misclassify the lift as a no-op (the underlying primitive `T`
        // is trivially "compatible with" itself).
        // Issue #2717: imported property and expression binding can mint
        // distinct symbols for the same CLR T, so use the binder's identity
        // classifier rather than symbol reference equality.
        if to is NullableTypeSymbol toValueNullableLift && ReflectionMetadataEmitter.IsValueTypeNullable(
            toValueNullableLift
        ) &&
            Conversion
            .ClassifyNonStructural(from, toValueNullableLift.UnderlyingType).IsIdentity {
            // Issue #814 / ADR-0084 §L5: open `T → Nullable<T>` where T is an
            // open type parameter constrained to `struct`. The closed ctor
            // is unavailable (T has no CLR type), so we emit a MemberRef
            // parented at the TypeSpec `Nullable<!!T>` with signature
            // `instance void .ctor(!0)`. The CLR resolves `!0` against the
            // parent's first generic argument at call time.
            if toValueNullableLift.UnderlyingType is TypeParameterSymbol {
                this.il.OpCode(ILOpCode.Newobj)
                this.il.Token(this.outer.memberRefs.GetNullableCtorMemberRefForOpenTypeParameter(toValueNullableLift))
                return
            }
            let innerClr = toValueNullableLift
                .UnderlyingType
                .ClrType ??
                throw InvalidOperationException(
                "Nullable<${toValueNullableLift.UnderlyingType.Name}> lift has no CLR underlying type."
            )
            // Issue #571: route the Nullable<T> construction through the
            // ReferenceResolver so the open `System.Nullable`1` definition and
            // the MLC-backed inner value type come from the same load context.
            // Building it from host `typeof(System.Nullable<>)` mixes the host
            // open generic with an MLC-backed `T`, which then fails inside
            // TypeBuilder/MetadataBuilder ctor-reference encoding as GS9998
            // with a bogus `(1,1,1,1)` cross-file location.
            if !NullableLifting.TryConstructNullable(this.outer.emitCtx.References, innerClr, out var nullableClr) {
                throw InvalidOperationException(
                    "Cannot construct Nullable<${innerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
                )
            }
            let nullableInnerArg = nullableClr.GetGenericArguments()[0]
            let ctor = nullableClr.GetConstructor([]Type{nullableInnerArg}) ??
                throw InvalidOperationException("Nullable<${nullableInnerArg.FullName}> has no single-arg constructor.")
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
            return
        }
        // Issue #1255: lifted nullable reference upcast `T? -> U?` where U is a
        // base class or implemented interface of T. Both sides are reference-
        // type Nullable<T>, which share the underlying reference's CLR
        // representation, so the upcast (and null propagation) is metadata-only —
        // the reference already on the stack is a valid U?. This mirrors the
        // `T -> U?` (#1121) and `T -> U` reference upcasts as a no-op.
        if from is NullableTypeSymbol fromRefNullable &&
            to is NullableTypeSymbol toRefNullable &&
            !ReflectionMetadataEmitter.IsValueTypeNullable(fromRefNullable) &&
            !ReflectionMetadataEmitter.IsValueTypeNullable(toRefNullable) &&
            IsReferenceCompatible(fromRefNullable.UnderlyingType, toRefNullable.UnderlyingType) {
            return
        }
        // Phase 3 exit: widening to a nullable reference type (`T` -> `T?`)
        // is metadata-only because reference nullability shares the CLR
        // representation. The same applies to narrowing back via `!!`.
        // Restrict to reference-type Nullable<T> — value-type Nullable<T>
        // is a distinct CLR struct and was handled by the dedicated branch
        // above (issue #504).
        // Issue #2717: mirror the binder's imported-type identity rule before
        // checking reference compatibility; nullable widening remains a no-op.
        if to is NullableTypeSymbol toNullable && !ReflectionMetadataEmitter.IsValueTypeNullable(toNullable) &&
            !ReflectionMetadataEmitter.IsValueTypeSymbol(from) &&
            (
            Conversion.ClassifyNonStructural(from, toNullable.UnderlyingType)
                .IsIdentity ||
                IsReferenceCompatible(from, toNullable.UnderlyingType)
        ) {
            return
        }
        if from is NullableTypeSymbol fromNullable && !ReflectionMetadataEmitter.IsValueTypeNullable(fromNullable) &&
            IsReferenceCompatible(fromNullable.UnderlyingType, to) {
            return
        }
        // Minimal numeric / to-string conversions sufficient for current language coverage.
        if to == TypeSymbol.Int32 && from == TypeSymbol.Bool {
            // bool already lives as i4 on the stack; no-op.
            return
        }
        if to == TypeSymbol.Bool && from == TypeSymbol.Int32 {
            this.il.LoadConstantI4(0)
            this.il.OpCode(ILOpCode.Ceq)
            this.il.LoadConstantI4(0)
            this.il.OpCode(ILOpCode.Ceq)
            return
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
        if !(from is NullableTypeSymbol) &&
            to is NullableTypeSymbol toValueNullableWiden &&
            ReflectionMetadataEmitter.IsValueTypeNullable(toValueNullableWiden) &&
            from != toValueNullableWiden.UnderlyingType &&
            TryEmitNumericConversion(from, toValueNullableWiden.UnderlyingType, conv.IsChecked) {
            let widenInnerClr = toValueNullableWiden
                .UnderlyingType
                .ClrType ??
                throw InvalidOperationException(
                "Nullable<${toValueNullableWiden.UnderlyingType.Name}> lift has no CLR underlying type."
            )
            if !NullableLifting.TryConstructNullable(
                this.outer.emitCtx.References,
                widenInnerClr,
                out var widenNullableClr
            ) {
                throw InvalidOperationException(
                    "Cannot construct Nullable<${widenInnerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
                )
            }
            let widenNullableInnerArg = widenNullableClr.GetGenericArguments()[0]
            let widenCtor = widenNullableClr.GetConstructor([]Type{widenNullableInnerArg}) ??
                throw InvalidOperationException(
                "Nullable<${widenNullableInnerArg.FullName}> has no single-arg constructor."
            )
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.outer.memberRefs.GetCtorReference(widenCtor))
            return
        }
        // Issues #1236/#3518: lifted conversion between two distinct value-type
        // `Nullable<T>` operands (numeric or underlying CLR user-defined).
        // The source struct is already on the stack; spill it, branch on
        // HasValue, and either re-wrap the converted underlying value as a fresh
        // `Nullable<T2>` (HasValue == true) or materialise default(Nullable<T2>)
        // (HasValue == false). Two consecutive scratch slots — the source
        // `Nullable<T1>` and the result `Nullable<T2>` — are pre-allocated by
        // the planner (CollectNullableValueTypeConversions) and keyed in
        // receiverSpillSlots by this conversion node (dest = source + 1).
        if from is NullableTypeSymbol fromValueNullableLift && ReflectionMetadataEmitter.IsValueTypeNullable(
            fromValueNullableLift
        ) &&
            to is NullableTypeSymbol toValueNullableLift2 &&
            ReflectionMetadataEmitter.IsValueTypeNullable(toValueNullableLift2) &&
            fromValueNullableLift.UnderlyingType != toValueNullableLift2
            .UnderlyingType {
            this.EmitLiftedNullableConversion(conv, fromValueNullableLift, toValueNullableLift2)
            return
        }
        // ADR-0044 numeric conversion lattice. Any pair of numeric CLR
        // primitives (sbyte/byte/short/ushort/int/uint/long/ulong/nint/
        // nuint/float/double/decimal/char) gets a typed IL conversion.
        // Issue #421 P2-5: route a checked conversion through the
        // overflow-trapping `conv.ovf.*` variants when requested.
        if TryEmitNumericConversion(from, to, conv.IsChecked) {
            return
        }
        // Issue #421 P2-5: enum ⇄ numeric (and enum ⇄ enum) conversions.
        // CLR enums share storage with their underlying primitive, so we
        // simply re-route through the numeric lattice substituting the
        // underlying type on whichever side carries the enum.
        if TryEmitEnumConversion(from, to, conv.IsChecked) {
            return
        }
        if (to.ClrType?.IsSameAs(typeof(object)) == true || IsInterfaceTargetType(to)) &&
            ReflectionMetadataEmitter
            .IsValueTypeSymbol(from) {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(from))
            return
        }
        // Issue #1218: a value-type value (notably an enum) converting to one of
        // its CLR reference base types — System.ValueType or System.Enum — boxes
        // to a proper object reference. This mirrors the `object`/interface box
        // above and lets inherited Enum/ValueType members receive the boxed
        // receiver/argument (e.g. an enum passed to System.Enum.HasFlag).
        if ReflectionMetadataEmitter.IsValueTypeSymbol(from) &&
            to.ClrType is Type valueBoxTarget &&
            (valueBoxTarget.IsSameAs(typeof(ValueType)) || valueBoxTarget.IsSameAs(typeof(Enum))) {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(from))
            return
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
        let genericBoxSource TypeParameterSymbol? = from as TypeParameterSymbol ??
            (from as NullableTypeSymbol)?.UnderlyingType as TypeParameterSymbol
        if genericBoxSource != nil && (to.ClrType?.IsSameAs(typeof(object)) == true || IsInterfaceTargetType(to)) {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(from))
            // Issue #3421 review follow-up: an unconstrained `T -> I`
            // explicit cast is `box !!T; castclass I`. The castclass is what
            // rejects incompatible reference and value instantiations.
            // Constraint-proven implicit `T -> I` conversions remain box-only.
            let interfaceTarget = if to is NullableTypeSymbol nullableInterfaceTarget {
                nullableInterfaceTarget.UnderlyingType
            } else {
                to
            }
            if IsInterfaceTargetType(interfaceTarget) && !Conversion.Classify(genericBoxSource, interfaceTarget)
                .IsImplicit {
                this.il.OpCode(ILOpCode.Castclass)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(interfaceTarget))
            }
            return
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
        if IsExplicitUnboxingSourceType(from) &&
            (
            (
                to is NullableTypeSymbol nullableUnboxTarget && NullableLifting.IsAnyValueTypeNullable(
                    nullableUnboxTarget
                )
            ) ||
                (!(to is NullableTypeSymbol) && ReflectionMetadataEmitter.IsValueTypeSymbol(to))
        ) {
            this.il.OpCode(ILOpCode.Unbox_any)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(to))
            return
        }
        // Issue #1455 (symmetric direction): `object`/interface → type
        // parameter, including a nullable wrapper over one (`T?`). The boxed
        // reference held in the `object`/interface slot is surfaced with
        // `unbox.any T` (or `unbox.any Nullable<!!T>`). The JIT picks the
        // value-vs-reference shape from the instantiated `T` at call time, so
        // this verifies for any closing instantiation. `GetElementTypeToken`
        // resolves the correct token for both the bare and nullable-wrapped
        // type parameter.
        if IsExplicitUnboxingSourceType(from) &&
            (
            to is TypeParameterSymbol ||
                (to is NullableTypeSymbol toNullableTp && toNullableTp.UnderlyingType is TypeParameterSymbol)
        ) {
            this.il.OpCode(ILOpCode.Unbox_any)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(to))
            return
        }
        if from.ClrType?.IsSameAs(typeof(object)) == true &&
            (to.ClrType == nil || !to.ClrType.IsSameAs(typeof(object))) &&
            !(to is TypeParameterSymbol) &&
            !ReflectionMetadataEmitter
            .IsValueTypeSymbol(to) {
            this.il.OpCode(ILOpCode.Castclass)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(to))
            return
        }
        // Issue #2130: expression-tree lowering builds the lambda node with the
        // non-generic Expression.Lambda(Type, ...) overload, whose static type
        // is LambdaExpression. The runtime instance is the exact
        // Expression<TDelegate> subtype requested by the supplied delegate
        // Type, so the synthesized final step is an explicit reference cast
        // from LambdaExpression to Expression<TDelegate>.
        if from
            .ClrType
            ?.FullName == "System.Linq.Expressions.LambdaExpression" &&
            to.ClrType != nil &&
            to
            .ClrType
            .IsGenericType &&
            string
            .Equals(
            (
                if to.ClrType.IsGenericTypeDefinition {
                    to.ClrType
                } else {
                    to.ClrType.GetGenericTypeDefinition()
                }
            ).FullName,
            "System.Linq.Expressions.Expression`1",
            StringComparison.Ordinal
        ) {
            this.il.OpCode(ILOpCode.Castclass)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(to))
            return
        }
        // Issue #2519: box a class-constrained type parameter when widening it
        // to the constraint, one of its bases, or an implemented interface.
        // For a reference-type instantiation `box !T` is a runtime no-op, while
        // giving the verifier the constrained reference shape it requires.
        //
        // Issue #3236: the same widening reaches emit through reference-
        // nullable wrappers on either side — `T? → Animal?`, `T → Animal?`
        // under `[T Animal]`. A class-base-constrained T is provably a
        // reference type, so its `T?` is a binder-level annotation over the
        // bare `!!T` slot (never `Nullable<!!T>` — that shape is value-type-
        // constrained and excluded by IsValueTypeNullable), and a nullable
        // reference target likewise erases to its underlying representation.
        // The lifted conversion therefore degenerates to the identical
        // `box !!T`: a null reference boxes to null, so nil flows through
        // unchanged, and a live reference is a runtime no-op box.
        let classConstrainedBoxSource = if from is NullableTypeSymbol fromRefLiftBox &&
            !ReflectionMetadataEmitter.IsValueTypeNullable(fromRefLiftBox) {
            fromRefLiftBox.UnderlyingType
        } else {
            from
        }
        let classConstrainedBoxTarget = if to is NullableTypeSymbol toRefLiftBox &&
            !ReflectionMetadataEmitter.IsValueTypeNullable(toRefLiftBox) {
            toRefLiftBox.UnderlyingType
        } else {
            to
        }
        if classConstrainedBoxSource is TypeParameterSymbol classConstrainedParameter &&
            classConstrainedParameter.ClassConstraint is TypeSymbol classConstraint &&
            IsReferenceCompatible(classConstraint, classConstrainedBoxTarget) {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(classConstrainedParameter))
            return
        }
        // Phase D: class → interface upcast is a CLR reference-level
        // no-op. The receiver already implements the interface; loading
        // the reference into an interface-typed slot needs no IL.
        if IsReferenceCompatible(from, to) {
            return
        }
        // Issue #3685: an explicitly spelled covariant one-dimensional array
        // upcast (`cast[[]FileSystemInfo](dirs)`). A G# slice IS a CLR SZ-array
        // (ADR-0016) and the CLR already treats a `D[]` reference as a `B[]`
        // for any base `B` of `D`, so the widening needs no IL at all — the
        // same no-op the class → base / class → interface arm above emits. The
        // `IsReferenceCompatible` probe misses it because a slice's element
        // relationship, not the slice symbol's own CLR backing, is what widens.
        if Conversion.IsCovariantArrayUpcast(from, to) {
            return
        }
        // Issue #3421: canonical `T(value)` reference downcasts use the CLR's
        // checked-cast operation. `castclass` preserves null, returns the same
        // reference on success, and throws InvalidCastException for an
        // incompatible non-null value. Reference-nullable targets erase to
        // their underlying type. A type-parameter target uses `unbox.any`,
        // matching C#'s generic cast lowering for both reference and value
        // instantiations.
        if Conversion.HasCheckedReferenceConversion(from, to) {
            let checkedTarget = if to is NullableTypeSymbol nullableCheckedTarget && Conversion.IsReferenceLikeTarget(
                nullableCheckedTarget.UnderlyingType
            ) {
                nullableCheckedTarget.UnderlyingType
            } else {
                to
            }
            this.il.OpCode(
                if checkedTarget is TypeParameterSymbol {
                    ILOpCode.Unbox_any
                } else {
                    ILOpCode.Castclass
                }
            )
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(checkedTarget))
            return
        }
        // Issue #663: fall back to user-defined op_Implicit / op_Explicit when
        // no built-in emit path fires. This covers types like JsonNode that
        // expose conversion operators to string, int, bool, etc.
        if from.ClrType != nil && to.ClrType != nil && ClrOperatorResolution.TryResolveConversionForTypes(
            from,
            to,
            allowExplicit: true,
            out var userConvMethod,
            out _
        ) {
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(this.outer.memberRefs.GetMethodReference(userConvMethod!!))
            return
        }
        // Issue #1441: `string(charArray)` — the G# rendering of C#
        // `new string(char[])`. The binder accepts a `[]char -> string`
        // conversion, but there is no primitive IL cast for it; materialise it
        // through the `System.String(char[])` constructor. Resolving the ctor
        // from `to.ClrType` (rather than `typeof(string)`) keeps it in the
        // active reference context (live host vs MetadataLoadContext).
        if to.ClrType != nil && to.ClrType.IsSameAs(typeof(string)) &&
            from.ClrType is {IsArray: true} fromArray &&
            fromArray.GetElementType() is Type fromElement && fromElement.IsSameAs(typeof(char)) {
            let stringCtor ConstructorInfo? = to.ClrType.GetConstructor([]Type{fromArray})
            if stringCtor != nil {
                this.il.OpCode(ILOpCode.Newobj)
                this.il.Token(this.outer.memberRefs.GetCtorReference(stringCtor))
                return
            }
        }
        // Issue #3956 / ADR-0172: the `from == to` fast path at the top of this
        // method is symbol REFERENCE equality, but one CLR type is routinely
        // minted as several non-reference-equal symbols — a nullability-
        // annotated wrapper on one side, a `ValueTuple<…>` recovered from a CLR
        // signature versus a `TupleTypeSymbol` carrying element NAMES on the
        // other. Element names are metadata over the positional shape and never
        // change the runtime type, so `KeyValuePair[string, (int32, int32,
        // List[(int32, int32, int32)])]` and the same shape written with names
        // are one type, and the binder duly classifies the conversion between
        // them as IDENTITY — yet every structural arm above keys off a specific
        // symbol shape and declines, leaving the crash below as the only
        // outcome. Ask the classifier the SHAPE question the reference check
        // cannot: when the two symbols denote the same type AND agree on their
        // CLR backing, the conversion is representation-preserving and needs no
        // IL at all, exactly like the `from == to` case. Both halves are
        // load-bearing — a `NullableTypeSymbol` relays its UNDERLYING type's
        // `ClrType` (#2051), so the CLR check alone would let a genuine
        // `T -> Nullable<T>` lift through unwrapped, and the identity check
        // alone would admit an alias whose backing legitimately differs.
        if from.ClrType != nil && to.ClrType != nil && ClrTypeUtilities.AreSame(from.ClrType, to.ClrType) &&
            Conversion
            .Classify(from, to).IsIdentity {
            return
        }
        // Issue #3998 (review finding 2): the explicit `cast[[M]T]([N]T)` the
        // binder now offers. #3998 made a fixed array's declared LENGTH part
        // of its type precisely because both lengths are backed by the ONE
        // CLR SZ-array `T[]` — which is also why this cast is a pure
        // reinterpretation that needs no IL at all, exactly like the identity
        // arm above. Only a SAME-COMPILATION element reaches here: with a
        // CLR-backed element both symbols carry the same `ClrType` and the
        // reference-conversion arm answers first, whereas `[3]Foo` and
        // `[4]Foo` both have a null `ClrType` while binding, so no
        // `ClrType`-keyed arm can fire. Emitting nothing keeps the value —
        // and therefore its real `.Length` — unchanged, which is what the
        // spec says the cast does.
        if from is ArrayTypeSymbol fromFixedArrayCast && to is ArrayTypeSymbol toFixedArrayCast && Conversion.Classify(
            fromFixedArrayCast.ElementType,
            toFixedArrayCast.ElementType
        )
            .IsIdentity {
            return
        }
        // Issue #4011: `map[K, V]` at one of the interfaces its
        // `Dictionary<K, V>` backing implements, over an OPEN key or value.
        // The value on the stack already IS that interface — a
        // `Dictionary<…>` reference implements all five — so, exactly like the
        // identity and fixed-array-cast arms above, the conversion is a
        // representation-preserving upcast that needs no IL. It reaches here
        // rather than the `HasCheckedReferenceConversion` arm for the reason
        // the issue exists: with an open element the map has NO `ClrType`, so
        // every `ClrType`-keyed arm declines. The CLOSED spelling does not
        // need this arm — it compiled and IL-verified before #4011, answered
        // earlier by one of the `ClrType`-keyed arms, and emits the same
        // nothing.
        //
        // The reference-nullable wrappers are stripped first, exactly as the
        // delegate arms above strip theirs: a `map[K, V]` IS a
        // `Dictionary<K, V>` reference, so `map[K, V]?` erases to the identical
        // representation and `(map[K, V])?` at an `(IDictionary[K, V])?` slot
        // is the same no-op. The classifier's own arm declines a nullable pair
        // by design — it leaves the lifted rules their say over the underlying
        // pair, and #3843's widening then routes it back here.
        if Conversion.IsMapInterfaceReferenceUpcast(UnwrapReferenceNullable(from), UnwrapReferenceNullable(to)) {
            return
        }
        EmitDiagnosticException.Wrap(
            conv.Syntax,
            NotSupportedException("Conversion from '${from.Name}' to '${to.Name}' is not yet supported by the emitter.")
        )
    }

    // Issues #1236/#3518: emit a lifted conversion between distinct value-type
    // nullable operands. On entry the source value is already on the stack.
    private func EmitLiftedNullableConversion(
        conv BoundConversionExpression,
        fromNullable NullableTypeSymbol,
        toNullable NullableTypeSymbol
    ) {
        if !this.receiverSpillSlots.TryGetValue(conv, out var srcSlot) {
            throw InvalidOperationException("No scratch slots allocated for a lifted nullable conversion.")
        }
        let dstSlot = srcSlot + 1
        let fromUnderlying = fromNullable.UnderlyingType
        let toUnderlying = toNullable.UnderlyingType
        let fromUnderlyingClr = fromUnderlying.ClrType ??
            throw InvalidOperationException(
            "Lifted Nullable<${fromUnderlying.Name}> widening: source underlying has no CLR type."
        )
        let toUnderlyingClr = toUnderlying.ClrType ??
            throw InvalidOperationException(
            "Lifted Nullable<${toUnderlying.Name}> widening: target underlying has no CLR type."
        )
        if !NullableLifting.TryConstructNullable(
            this.outer.emitCtx.References,
            toUnderlyingClr,
            out var toNullableClr
        ) {
            throw InvalidOperationException(
                "Cannot construct Nullable<${toUnderlyingClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
            )
        }
        let toNullableInnerArg = toNullableClr.GetGenericArguments()[0]
        let toCtor = toNullableClr.GetConstructor([]Type{toNullableInnerArg}) ??
            throw InvalidOperationException("Nullable<${toNullableInnerArg.FullName}> has no single-arg constructor.")
        let toNullableToken = this.outer.memberRefs.GetTypeHandleForMember(toNullableClr)
        let getHasValue = this.outer.wellKnown.GetNullableGetHasValueReference(fromUnderlyingClr)
        let getValueOrDefault = this.outer.wellKnown.GetNullableGetValueOrDefaultReference(fromUnderlyingClr)
        let nullBranch = this.il.DefineLabel()
        let end = this.il.DefineLabel()
        // Spill the source Nullable<T1> and branch on HasValue.
        this.il.StoreLocal(srcSlot)
        this.il.LoadLocalAddress(srcSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getHasValue)
        this.il.Branch(ILOpCode.Brfalse, nullBranch)
        // Present: unwrap, convert the underlying value, re-wrap as Nullable<T2>.
        this.il.LoadLocalAddress(srcSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(getValueOrDefault)
        if !this.TryEmitNumericConversion(fromUnderlying, toUnderlying, conv.IsChecked) {
            if !ClrOperatorResolution.TryResolveConversion(
                fromUnderlyingClr,
                toUnderlyingClr,
                allowExplicit: false,
                out var conversionMethod,
                out _
            ) {
                throw InvalidOperationException(
                    "Lifted Nullable<${fromUnderlying.Name}> to Nullable<${toUnderlying.Name}> conversion has no underlying conversion."
                )
            }
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(this.outer.memberRefs.GetMethodReference(conversionMethod))
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetCtorReference(toCtor))
        this.il.Branch(ILOpCode.Br, end)
        // Absent: materialise default(Nullable<T2>).
        this.il.MarkLabel(nullBranch)
        this.il.LoadLocalAddress(dstSlot)
        this.il.OpCode(ILOpCode.Initobj)
        this.il.Token(toNullableToken)
        this.il.LoadLocal(dstSlot)
        this.il.MarkLabel(end)
    }

    /// ADR-0193 Phase 2: the CLR-return overload. The widening only asks
    /// whether the reflected return is `System.Object` — the one CLR type
    /// that maps to (cref:TypeSymbol.Object), compared by full name as
    /// (cref:TypeSymbol.FromClrType) compares it — so the signature
    /// position is tested in place rather than converted to a symbol.
    /// @param runtimeReturnClr The reflected return type of the called member.
    /// @param expectedType The bound (symbolic) type of the call.
    private func EmitErasedObjectReturnWidening(runtimeReturnClr Type, expectedType TypeSymbol?) {
        if runtimeReturnClr.FullName == "System.Object" {
            this.EmitErasedObjectReturnWidening(TypeSymbol.Object, expectedType)
        }
    }

    private func EmitErasedObjectReturnWidening(runtimeReturnType TypeSymbol, expectedType TypeSymbol?) {
        if !IsObjectStackType(runtimeReturnType) ||
            expectedType == nil ||
            expectedType == TypeSymbol.Void ||
            expectedType == TypeSymbol.Error ||
            expectedType
            .ClrType
            ?.IsSameAs(typeof(object)) == true {
            return
        }
        // ADR-0087 §3 R4: when the source is `object` (erased return from a
        // non-reified call site, e.g. IList::get_Item) and the target is a
        // type parameter or a generic-instantiation containing one, emit
        // `unbox.any T` (or `unbox.any List<!!0>` etc.). The JIT picks the
        // value-vs-reference shape from the instantiated `T` at call time.
        if expectedType is TypeParameterSymbol expectedTp {
            this.il.OpCode(ILOpCode.Unbox_any)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(expectedTp))
            return
        }
        if TypeSymbol.ContainsTypeParameter(expectedType) {
            this.il.OpCode(ILOpCode.Unbox_any)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(expectedType))
            return
        }
        if ReflectionMetadataEmitter.IsValueTypeSymbol(expectedType) {
            this.il.OpCode(ILOpCode.Unbox_any)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(expectedType))
            return
        }
        this.il.OpCode(ILOpCode.Castclass)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(expectedType))
    }

    // ADR-0044 numeric conversions. Maps the from/to CLR pair to the
    // appropriate `conv.*` opcode or, for `decimal`, to the matching
    // implicit/explicit operator method. Returns true when an emission
    // was made. Issue #421 P2-5: when <paramref name="isChecked"/> is
    // true the narrowing is emitted with the overflow-trapping
    // `conv.ovf.*` opcodes so values that don't fit the target throw
    // <see cref="System.OverflowException"/> instead of truncating.
    private func TryEmitNumericConversion(fromSym TypeSymbol?, toSym TypeSymbol?, isChecked bool = false) bool {
        let from Type? = fromSym?.ClrType
        let to Type? = toSym?.ClrType
        if from == nil || to == nil {
            return false
        }
        if !IsNumericClrType(from) || !IsNumericClrType(to) {
            return false
        }
        // decimal is a value type with no `conv.*` opcode; route through
        // the BCL's operator methods. `op_Implicit` for widening sources
        // (every integral type → decimal) and `op_Explicit` otherwise.
        if to.IsSameAs(typeof(decimal)) || from.IsSameAs(typeof(decimal)) {
            return TryEmitDecimalConversion(from, to)
        }
        // ECMA-335 conv.r4/conv.r8 interpret integer inputs as signed.
        // Unsigned inputs must first use conv.r.un; float32 then needs
        // conv.r4 to truncate the intermediate floating-point value.
        if IsUnsignedClrType(from) && (to.IsSameAs(typeof(float32)) || to.IsSameAs(typeof(float64))) {
            this.il.OpCode(ILOpCode.Conv_r_un)
            if to.IsSameAs(typeof(float32)) {
                this.il.OpCode(ILOpCode.Conv_r4)
            }
            return true
        }
        if isChecked {
            return TryEmitCheckedNumericConversion(from, to)
        }
        // Stack-type bookkeeping: anything narrower than i4 is widened to
        // i4 on the evaluation stack, so the source's stack shape is
        // determined by `from`'s size only when it's i8, native int, r4,
        // or r8. We pick the conv opcode that matches the *target*
        // representation.
        var op ILOpCode? = nil
        if to.IsSameAs(typeof(int8)) {
            op = ILOpCode.Conv_i1
        } else if to.IsSameAs(typeof(uint8)) {
            op = ILOpCode.Conv_u1
        } else if to.IsSameAs(typeof(int16)) {
            op = ILOpCode.Conv_i2
        } else if to.IsSameAs(typeof(uint16)) || to.IsSameAs(typeof(char)) {
            op = ILOpCode.Conv_u2
        } else if to.IsSameAs(typeof(int32)) {
            // From an i4-sized source the value is already i4. From i8,
            // r4, r8, nint, nuint we must narrow to i4.
            if Is32BitOrSmaller(from) {
                return true
            }
            op = ILOpCode.Conv_i4
        } else if to.IsSameAs(typeof(uint32)) {
            if Is32BitOrSmaller(from) {
                return true
            }
            op = ILOpCode.Conv_u4
        } else if to.IsSameAs(typeof(int64)) || to.IsSameAs(typeof(uint64)) || to.IsSameAs(typeof(nint)) || to.IsSameAs(
            typeof(nuint)
        ) {
            // ECMA-335: widening to a 64-bit/native-int slot must
            // sign-extend or zero-extend based on the SOURCE's
            // signedness, not the target's. `uint32 -> int64` needs
            // `conv.u8` (zero-extend); `int32 -> uint64` needs
            // `conv.i8` (sign-extend). Float sources have no signedness
            // distinction, so those keep the target-based opcode.
            let fromFloat = from.IsSameAs(typeof(float32)) || from.IsSameAs(typeof(float64))
            let useUnsigned = if fromFloat {
                (to.IsSameAs(typeof(uint64)) || to.IsSameAs(typeof(nuint)))
            } else {
                IsUnsignedClrType(from)
            }
            if to.IsSameAs(typeof(int64)) || to.IsSameAs(typeof(uint64)) {
                op = if useUnsigned {
                    ILOpCode.Conv_u8
                } else {
                    ILOpCode.Conv_i8
                }
            } else {
                op = if useUnsigned {
                    ILOpCode.Conv_u
                } else {
                    ILOpCode.Conv_i
                }
            }
        } else if to.IsSameAs(typeof(float32)) {
            op = ILOpCode.Conv_r4
        } else if to.IsSameAs(typeof(float64)) {
            op = ILOpCode.Conv_r8
        }
        if op == nil {
            return false
        }
        this.il.OpCode(op)
        return true
    }

    // Issue #3755 listed the `typeof(decimal)` probes below as residual
    // host-`typeof` sites. Left as they are, deliberately: `from` and `to`
    // cannot be MetadataLoadContext types here. `TypeSymbol.FromClrType` maps
    // every numeric CLR type onto a built-in symbol BY FULL NAME precisely so
    // MLC primitives normalise (see its `case "System.Decimal": return Decimal`
    // switch), and `IsNumericClrType` — which the sole caller gates on — admits
    // nothing else. So `GetMethod(name, new[] { from })`, which could never
    // match across contexts, is only ever asked a host-to-host question, and
    // the emitted MemberRef's parent is projected by
    // `ImportedMemberRefFactory.GetTypeReference` regardless: compiling a
    // decimal conversion against NETStandard.Library.Ref 2.1.0 emits
    // `System.Decimal -> netstandard`. `System.Decimal` and its operators are
    // also present in every target framework, so there is no #3730-shaped
    // absence to guard. Recorded so a future sweep does not re-derive it.
    private func TryEmitDecimalConversion(from Type, to Type) bool {
        // To decimal: every numeric source has either an `op_Implicit`
        // (integrals, char) or an `op_Explicit` (float, double).
        if to.IsSameAs(typeof(decimal)) {
            let op MethodInfo? = typeof(decimal).GetMethod("op_Implicit", []Type{from}) ?? typeof(decimal).GetMethod(
                "op_Explicit",
                []Type{from}
            )
            if op == nil {
                return false
            }
            this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(op))
            return true
        }
        // From decimal: every numeric target has an `op_Explicit`.
        if from.IsSameAs(typeof(decimal)) {
            // `System.Decimal` declares many `op_Explicit(decimal)`
            // overloads that differ ONLY by return type (decimal -> byte,
            // sbyte, short, ushort, int, uint, long, ulong, float, double,
            // char). `Type.GetMethod(name, Type[])` matches by parameter
            // signature alone and would throw `AmbiguousMatchException`, so
            // we must disambiguate by BOTH parameter and return type by
            // iterating the operator overloads ourselves.
            var op MethodInfo? = nil
            for m in typeof(decimal).GetMethods() {
                if m.Name == "op_Explicit" && m.ReturnType.IsSameAs(to) && m.GetParameters()
                    .Length == 1 &&
                    m
                    .GetParameters()[0]
                    .ParameterType
                    .IsSameAs(typeof(decimal)) {
                    op = m
                    break
                }
            }
            if op == nil {
                return false
            }
            this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(op))
            return true
        }
        return false
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
    private func TryEmitCheckedNumericConversion(from Type, to Type) bool {
        let sourceUnsigned = IsUnsignedClrType(from)
        var op ILOpCode? = nil
        if to.IsSameAs(typeof(int8)) {
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_i1_un
            } else {
                ILOpCode.Conv_ovf_i1
            }
        } else if to.IsSameAs(typeof(uint8)) {
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_u1_un
            } else {
                ILOpCode.Conv_ovf_u1
            }
        } else if to.IsSameAs(typeof(int16)) {
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_i2_un
            } else {
                ILOpCode.Conv_ovf_i2
            }
        } else if to.IsSameAs(typeof(uint16)) || to.IsSameAs(typeof(char)) {
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_u2_un
            } else {
                ILOpCode.Conv_ovf_u2
            }
        } else if to.IsSameAs(typeof(int32)) {
            // From a same-size signed source the value already fits, but
            // from a same-size unsigned source we still need the check
            // (`uint` → `int` traps for values > Int32.MaxValue).
            if from.IsSameAs(typeof(int32)) {
                return true
            }
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_i4_un
            } else {
                ILOpCode.Conv_ovf_i4
            }
        } else if to.IsSameAs(typeof(uint32)) {
            if from.IsSameAs(typeof(uint32)) {
                return true
            }
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_u4_un
            } else {
                ILOpCode.Conv_ovf_u4
            }
        } else if to.IsSameAs(typeof(int64)) {
            // A signed widening (i1/i2/i4 → i8) needs `conv.i8` (not
            // `conv.ovf.i8`) because it can't overflow; the same holds
            // for the identity i8 → i8. An unsigned source widening to
            // long uses `conv.ovf.i8.un` to trap on the >Int64.MaxValue
            // boundary; an unsigned same-size widening (uint → long) is
            // safe but the `_un` variant still trivially succeeds.
            if from.IsSameAs(typeof(int64)) {
                return true
            }
            if sourceUnsigned {
                op = ILOpCode.Conv_ovf_i8_un
            } else if from.IsSameAs(typeof(float32)) || from.IsSameAs(typeof(float64)) {
                op = ILOpCode.Conv_ovf_i8
            } else {
                // Signed integral widening cannot overflow; emit the
                // plain widening opcode.
                op = ILOpCode.Conv_i8
            }
        } else if to.IsSameAs(typeof(uint64)) {
            if from.IsSameAs(typeof(uint64)) {
                return true
            }
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_u8_un
            } else {
                ILOpCode.Conv_ovf_u8
            }
        } else if to.IsSameAs(typeof(nint)) {
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_i_un
            } else {
                ILOpCode.Conv_ovf_i
            }
        } else if to.IsSameAs(typeof(nuint)) {
            op = if sourceUnsigned {
                ILOpCode.Conv_ovf_u_un
            } else {
                ILOpCode.Conv_ovf_u
            }
        } else if to.IsSameAs(typeof(float32)) {
            op = ILOpCode.Conv_r4
        } else if to.IsSameAs(typeof(float64)) {
            op = ILOpCode.Conv_r8
        }
        if op == nil {
            return false
        }
        this.il.OpCode(op)
        return true
    }

    // Issue #421 P2-5: enum ⇄ numeric (and enum ⇄ enum). CLR enum
    // storage is identical to the underlying integral, so we route the
    // conversion through the numeric lattice using the underlying type
    // on whichever side carries the enum.
    private func TryEmitEnumConversion(from TypeSymbol, to TypeSymbol, isChecked bool) bool {
        let fromUnderlying TypeSymbol? = GetEnumUnderlyingTypeSymbol(from)
        let toUnderlying TypeSymbol? = GetEnumUnderlyingTypeSymbol(to)
        if fromUnderlying == nil && toUnderlying == nil {
            return false
        }
        let effectiveFrom = fromUnderlying ?? from
        let effectiveTo = toUnderlying ?? to
        // If the underlying primitives are identical (e.g. `Color` enum
        // ↔ int32, or one int-backed enum ↔ another int-backed enum)
        // the IL representation is the same and we emit nothing — the
        // i4 already on the stack is the result.
        if effectiveFrom?.ClrType != nil &&
            effectiveTo?.ClrType != nil &&
            effectiveFrom.ClrType == effectiveTo.ClrType {
            return true
        }
        return TryEmitNumericConversion(effectiveFrom, effectiveTo, isChecked)
    }

    private func EmitDefault(node BoundDefaultExpression) {
        let type = node.Type
        // Issue #3285: pointer defaults use the same native-int zero as
        // explicit `nil` conversions. `ldnull` is an object reference and is
        // invalid when the evaluation-stack slot expects a pointer.
        if this.TryEmitPointerLikeDefault(type) {
            return
        }
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
        let typeParamLike = type is TypeParameterSymbol ||
            (type is ImportedTypeSymbol erasedGen && erasedGen.HasTypeParameterArgument) ||
            (type is NullableTypeSymbol nullableTp && nullableTp.UnderlyingType is TypeParameterSymbol)
        // Reference types: ldnull
        if !typeParamLike && !ReflectionMetadataEmitter.IsValueTypeSymbol(type) {
            this.il.OpCode(ILOpCode.Ldnull)
            return
        }
        // Primitive value types: push zero constant
        if type == TypeSymbol.Int32 || type == TypeSymbol.Bool {
            this.il.LoadConstantI4(0)
            return
        }
        // Arbitrary value type (or type-parameter / erased open generic):
        // ldloca temp; initobj T; ldloc temp
        if !this.defaultExpressionSlots.TryGetValue(node, out var slot) {
            throw InvalidOperationException(
                "No slot populated for ${node.Kind} of value type '${type.Name}' — " +
                    "walker pre-pass missed this child? " +
                    "Check DefaultExpressionCollector and its ancestor walker."
            )
        }
        this.il.LoadLocalAddress(slot)
        this.il.OpCode(ILOpCode.Initobj)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(type))
        this.il.LoadLocal(slot)
    }

    private func TryEmitPointerLikeDefault(type TypeSymbol) bool {
        if !(type is PointerTypeSymbol) && !(type is FunctionPointerTypeSymbol) {
            return false
        }
        this.il.LoadConstantI4(0)
        this.il.OpCode(ILOpCode.Conv_i)
        return true
    }

    /// Issue #988: emits the construction of a type parameter `T` that carries a
    /// `new()` constraint — the G# spelling `T()`. Lowered to a reified
    /// `call !!0 [System.Runtime]System.Activator::CreateInstance<!!T>()`
    /// (ADR-0087). `Activator.CreateInstance<T>()` is the standard C#
    /// `new()`-constraint lowering and yields a real instance for both reference
    /// types with a public parameterless ctor and value types.
    private func EmitTypeParameterConstruction(node BoundTypeParameterConstructionExpression) {
        var openCreateInstance MethodInfo? = nil
        for method in typeof(Activator).GetMethods(BindingFlags.Public | BindingFlags.Static) {
            if method.Name == "CreateInstance" && method.IsGenericMethodDefinition && method.GetGenericArguments()
                .Length == 1 &&
                method
                .GetParameters().Length == 0 {
                openCreateInstance = method
                break
            }
        }
        openCreateInstance = Invariant.Required(
            openCreateInstance,
            "Activator.CreateInstance<T>() is available",
            expression: "openCreateInstance"
        )
        // Close the open definition with a placeholder; GetMethodEntityHandle
        // re-encodes the real type argument (the in-scope type parameter, a
        // VAR/MVAR) into the MethodSpec via the symbolic-argument path.
        let closed = openCreateInstance.MakeGenericMethod(typeof(object))
        let symbolicTypeArguments = ImmutableArray.Create[TypeSymbol?](node.TypeParameter)
        let handle = this.outer.memberRefs.GetMethodEntityHandle(closed, typeArgSymbols: symbolicTypeArguments)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(handle)
    }

    private func EmitClrConversionCall(conv BoundClrConversionCallExpression) {
        if conv.IsLifted &&
            conv
            .Source
            .Type is NullableTypeSymbol sourceNullable &&
            conv.Type is NullableTypeSymbol liftedTargetNullable {
            this.EmitLiftedNullableClrConversion(conv, sourceNullable, liftedTargetNullable)
            return
        }
        // Stream E emit parity: user-defined op_Implicit / op_Explicit is a
        // public-static method taking one arg, returning the target type.
        let method = Invariant.Required(
            conv.Method,
            "a non-lifted imported conversion carries a CLR method",
            expression: "conv.Method"
        )
        this.EmitExpression(conv.Source)
        this.il.OpCode(ILOpCode.Call)
        // Issue #3932: `ConversionClassifier.TryResolveSymbolicImportedConversion`
        // hands back the OPEN operator (`Memory`1::op_Implicit`) precisely
        // because the target is symbolic (`Memory[T]` for an open `T`).
        // Referencing it through the plain MemberRef path parents it at the
        // OPEN `Memory`1`, which is the same open-vs-closed defect the chained
        // `.ctor` had; route it through the #671 symbolic-container factory so
        // the parent is the `Memory`1<!!T>` TypeSpec. An open declaring type is
        // a shape ordinary CLR operator resolution never produces, so this
        // cannot re-target an existing conversion.
        let nativeOwner = if conv.Type is NullableTypeSymbol nullableNativeOwner {
            nullableNativeOwner.UnderlyingType
        } else {
            conv.Type
        }
        this.il.Token(
            if NativeSliceTypes.IsDefinition(method.DeclaringType, out _) && NativeSliceTypes.TryGetElement(
                nativeOwner,
                out _,
                out _
            ) {
                this.outer.memberRefs.GetMethodEntityHandle(method, nativeOwner)
            } else {
                (
                    if method.DeclaringType is {IsGenericTypeDefinition: true} {
                        this
                            .outer
                            .memberRefs
                            .GetMethodEntityHandle(
                            method,
                            default(ImmutableArray[TypeSymbol?]),
                            SymbolicConversionOwner(method, UnwrapNullable(conv.Source.Type), UnwrapNullable(conv.Type))
                        )
                    } else {
                        this.outer.memberRefs.GetMethodReference(method)
                    }
                )
            }
        )
        this.EmitErasedObjectReturnWidening(method.ReturnType, conv.Type)
        // Issue #663: when the operator returns a non-nullable value type T but the
        // target type is Nullable<T> (e.g. op_Explicit(JsonNode) → int, target int32?),
        // lift the result into Nullable<T> via newobj.
        if conv.Type is NullableTypeSymbol targetNullable && ReflectionMetadataEmitter.IsValueTypeNullable(
            targetNullable
        ) &&
            method
            .ReturnType
            .IsValueType &&
            !IsNullableValueType(method.ReturnType) {
            let innerClr = targetNullable
                .UnderlyingType
                .ClrType ??
                throw InvalidOperationException(
                "Nullable<${targetNullable.UnderlyingType.Name}> lift has no CLR underlying type."
            )
            if !NullableLifting.TryConstructNullable(this.outer.emitCtx.References, innerClr, out var nullableClr) {
                throw InvalidOperationException(
                    "Cannot construct Nullable<${innerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
                )
            }
            let nullableInnerArg = nullableClr.GetGenericArguments()[0]
            let ctor = nullableClr.GetConstructor([]Type{nullableInnerArg}) ??
                throw InvalidOperationException("Nullable<${nullableInnerArg.FullName}> has no single-arg constructor.")
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
        }
    }

    private func EmitLiftedNullableClrConversion(
        conv BoundClrConversionCallExpression,
        sourceNullable NullableTypeSymbol,
        targetNullable NullableTypeSymbol
    ) {
        if !this.receiverSpillSlots.TryGetValue(conv, out var sourceSlot) {
            throw InvalidOperationException("No scratch slots allocated for a lifted nullable CLR conversion.")
        }
        let resultSlot = sourceSlot + 1
        let nullBranch = this.il.DefineLabel()
        let end = this.il.DefineLabel()
        this.EmitExpression(conv.Source)
        this.il.StoreLocal(sourceSlot)
        this.il.LoadLocalAddress(sourceSlot)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(this.GetNullableHasValueRef(sourceNullable))
        this.il.Branch(ILOpCode.Brfalse, nullBranch)
        this.EmitUnwrappedNullableValue(sourceSlot, sourceNullable)
        this.EmitCallResolvedConversion(conv)
        if NullableLifting.IsAnyValueTypeNullable(targetNullable) {
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(this.GetNullableResultConstructor(targetNullable))
        }
        this.il.Branch(ILOpCode.Br, end)
        this.il.MarkLabel(nullBranch)
        if NullableLifting.IsAnyValueTypeNullable(targetNullable) ||
            targetNullable.UnderlyingType is TypeParameterSymbol {
            // A class-constrained type parameter still needs a typed default
            // at the join, just as in EmitDefault (#814).
            this.il.LoadLocalAddress(resultSlot)
            this.il.OpCode(ILOpCode.Initobj)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(targetNullable))
            this.il.LoadLocal(resultSlot)
        } else {
            this.il.OpCode(ILOpCode.Ldnull)
        }
        this.il.MarkLabel(end)
    }

    private func EmitCallResolvedConversion(conversion BoundClrConversionCallExpression) {
        if conversion.Function != nil {
            this.EmitCallResolvedUserFunction(conversion.Function, conversion.FunctionOwnerType)
            return
        }
        let conversionMethod = Invariant.Required(
            conversion.Method,
            "an imported conversion carries a CLR method",
            expression: "conversion.Method"
        )
        // Issue #3932: as in EmitClrConversionCall — a symbolically resolved
        // operator arrives as the OPEN method and must be parented at the
        // constructed TypeSpec rather than at the open definition.
        this.il.OpCode(ILOpCode.Call)
        let nativeOwner = if conversion.Type is NullableTypeSymbol nullableNativeOwner {
            nullableNativeOwner.UnderlyingType
        } else {
            conversion.Type
        }
        this.il.Token(
            if NativeSliceTypes.IsDefinition(conversionMethod.DeclaringType, out _) && NativeSliceTypes.TryGetElement(
                nativeOwner,
                out _,
                out _
            ) {
                this.outer.memberRefs.GetMethodEntityHandle(conversionMethod, nativeOwner)
            } else {
                (
                    if conversionMethod.DeclaringType is {IsGenericTypeDefinition: true} {
                        this
                            .outer
                            .memberRefs
                            .GetMethodEntityHandle(
                            conversionMethod,
                            default(ImmutableArray[TypeSymbol?]),
                            SymbolicConversionOwner(
                                conversionMethod,
                                UnwrapNullable(conversion.Source.Type),
                                UnwrapNullable(conversion.Type)
                            )
                        )
                    } else {
                        this.outer.memberRefs.GetMethodReference(conversionMethod)
                    }
                )
            }
        )
    }

    private func EmitZeroInit(slot int32, gsharpType TypeSymbol, clrType Type) {
        this.il.LoadLocalAddress(slot)
        this.il.OpCode(ILOpCode.Initobj)
        let initType = if ChannelElementNeedsSymbolicType(gsharpType) {
            gsharpType
        } else {
            TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.EmitShape)
        }
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(initType))
    }

    shared {
        /// ADR-0174 D2: `chan[T]` to `in`/`out chan[T]` is a real
        /// conversion — `get_Reader` / `get_Writer` — even when the two
        /// sides look runtime-equivalent, which they do whenever the element is an
        /// open type parameter. Without this the view call is dropped and a generic
        /// function taking `in chan[T]` is handed a `Channel[T]`.
        /// @param from The source type.
        /// @param to The target type.
        /// @returns `true` when the channel conversion needs emitted IL.
        private func RequiresChannelConversionEmission(
            from TypeSymbol?,
            to TypeSymbol?
        ) bool -> ChannelTypeSymbol.TryGetChannelShape(from, out _, out var fromDirection, out var fromConstructed) &&
            ChannelTypeSymbol.TryGetChannelShape(to, out _, out var toDirection, out var toConstructed) &&
            (fromDirection != toDirection || (toConstructed && !fromConstructed))

        /// Issue #2840 / #2841: strips reference-nullable wrappers so the
        /// delegate-materialisation arms of (cref:EmitConversion) see the
        /// bare function / delegate shape. (The channel arm above needs no help:
        /// (cref:ChannelTypeSymbol.TryGetChannelShape) looks through both
        /// wrapper kinds itself.) A (cref:NullableTypeSymbol) over a
        /// reference type is a binder-level annotation that erases to the
        /// underlying type's CLR representation, so a `D?` or
        /// `((P…) -> R)?` slot
        /// materialises byte-identically to its bare form. Genuine
        /// `Nullable<T>` value shapes are left wrapped so they keep
        /// reaching the value-type arms.
        /// @param type The declared source or target type of the conversion.
        /// @returns The unwrapped type, or [`type`](paramref) when no reference-nullable wrapper applies.
        private func UnwrapReferenceNullable(type TypeSymbol) TypeSymbol {
            var type = type
            while true {
                if type is NullableTypeSymbol nullable && !ReflectionMetadataEmitter.IsValueTypeNullable(nullable) &&
                    nullable.UnderlyingType != nil {
                    type = nullable.UnderlyingType
                    continue
                }
                // ADR-0186 §1: `T!` is a reference-nullability annotation over an
                // identical CLR representation, exactly as a reference `T?` is.
                if type is PlatformTypeSymbol platform {
                    type = platform.UnderlyingType
                    continue
                }
                return type
            }
        }

        // Issue #4350: an open imported conversion operator is parented at the
        // symbolic TypeSpec of whichever side declares it — the target for
        // `Memory`1::op_Implicit(!0[])` (#3932), the source for
        // `Span`1::op_Implicit(Span<!0>) : ReadOnlySpan<!0>`.
        private func SymbolicConversionOwner(
            method MethodInfo,
            source TypeSymbol,
            target TypeSymbol
        ) TypeSymbol -> if source is ImportedTypeSymbol{OpenDefinition: {} sourceOpen} &&
            method.DeclaringType is {} declaring &&
            ClrTypeUtilities.AreSame(sourceOpen, declaring) &&
            !(
            target is ImportedTypeSymbol{OpenDefinition: {} targetOpen} && ClrTypeUtilities.AreSame(
                targetOpen,
                declaring
            )
        ) {
            source
        } else {
            target
        }

        private func UnwrapNullable(type TypeSymbol) TypeSymbol -> if type is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            type
        }

        private func IsNullableValueType(t Type) bool {
            return t.IsGenericType && !t.IsGenericTypeDefinition && string.Equals(
                t.GetGenericTypeDefinition().FullName,
                "System.Nullable`1",
                StringComparison.Ordinal
            )
        }
    }
}
