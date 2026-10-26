// <copyright file="SignatureEncoder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Runtime.InteropServices
import System.Threading.Tasks

/// PR-E-17 (#1361): the signature / type-encoding band. Owns every method that
/// renders a G# (cref:TypeSymbol) (or a reflection (cref:Type))
/// into an ECMA-335 signature blob — the core of the emitter's metadata output.
/// Covers the recursive `EncodeTypeSymbol` / `EncodeClrType` pair, the
/// return-type and local-variable encoders, the reified delegate
/// (`Func`/`Action`) shape encoder, the function-pointer call-site
/// signature, and the host→reference-context CLR type resolution the reflection
/// encoding path depends on
/// (`ResolveDelegateClrType` / `ResolveAsyncDelegateClrType` /
/// `MapToReferenceClrType`).
/// @remarks Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// InterfaceImplEmitter idiom) because the band reaches
/// (cref:EmitContext), (cref:MetadataTokenCache),
/// (cref:GenericRemapState), AND several user-token resolvers that only
/// move in later PRs ((cref:ImportedMemberRefFactory.GetTypeReference),
/// `ResolveUserStructTypeSpecArguments`, `ResolveDelegateTypeArguments`,
/// and the async-state-machine plans on
/// (cref:ReflectionMetadataEmitter.stateMachines)). Those temporary
/// couplings are reached through (cref:outer) and are resolved when the
/// token-resolution band is extracted (E-18/E-19). Direct convenience fields
/// hold the shared (cref:EmitContext) / (cref:MetadataTokenCache)
/// / (cref:GenericRemapState) read off the back-reference.
///
/// The active-remap reads route through
/// (cref:GenericRemapState.ActiveIteratorStateMachineRemap) /
/// (cref:GenericRemapState.ActiveLambdaMethodTypeParamRemap); the getter
/// returns the same live Dictionary reference the emitter mutates, so it is
/// read (never snapshotted) exactly as the pre-E-17 band did. Method bodies are
/// verbatim moves; emitted PEs are byte-identical with the pre-E-17 baseline.
internal class SignatureEncoder {
    private let outer ReflectionMetadataEmitter
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let remaps GenericRemapState

    init(outer ReflectionMetadataEmitter) {
        this.outer = outer ?? throw ArgumentNullException("outer")
        this.emitCtx = outer.emitCtx
        this.cache = outer.cache
        this.remaps = outer.remaps
    }

    internal func EncodeLocalVariableType(enc LocalVariableTypeEncoder, t TypeSymbol) {
        // ADR-0125 / issue #1026: a `fixed` statement's pinned local carries the
        // CLR `pinned` flag so the GC cannot relocate the pinned buffer. The
        // underlying storage is either a managed by-ref (`T& pinned`, string
        // form) or an ordinary managed type such as the array (`T[] pinned`,
        // array form).
        if t is PinnedTypeSymbol pinned {
            if pinned.UnderlyingType is ByRefTypeSymbol pinnedByRef {
                EncodeTypeSymbol(enc.Type(isByRef: true, isPinned: true), pinnedByRef.PointeeType)
            } else {
                EncodeTypeSymbol(enc.Type(isByRef: false, isPinned: true), pinned.UnderlyingType)
            }
            return
        }
        if t is ByRefTypeSymbol byRef {
            EncodeTypeSymbol(enc.Type(isByRef: true), byRef.PointeeType)
        } else {
            EncodeTypeSymbol(enc.Type(), t)
        }
    }

    internal func EncodeTypeSymbol(encoder SignatureTypeEncoder, type TypeSymbol?) {
        // ADR-0122 / issue #1014: an *unmanaged* pointer type (PointerTypeSymbol
        // → CLR ELEMENT_TYPE_PTR) is encoded by emitting the `*` element-type
        // prefix and recursing on the pointee. Unlike ELEMENT_TYPE_BYREF this is
        // a valid SignatureTypeEncoder element, so fields, parameters, returns,
        // and locals all flow through this branch uniformly.
        if type is PointerTypeSymbol ptr {
            let pointerEncoder = encoder.Pointer()
            // ADR-0122 §3 / issue #1033: `*void` (C# `void*`) encodes as
            // ELEMENT_TYPE_PTR over ELEMENT_TYPE_VOID. SignatureTypeEncoder has
            // no `Void()` helper (void is only valid as a return or pointee), so
            // write the raw ELEMENT_TYPE_VOID type-code byte after the pointer
            // prefix that `encoder.Pointer()` already emitted.
            if ptr.PointeeType == TypeSymbol.Void {
                pointerEncoder.Builder.WriteByte(uint8(SignatureTypeCode.Void))
                return
            }
            EncodeTypeSymbol(pointerEncoder, ptr.PointeeType)
            return
        }
        // ADR-0060 §13 / migration: a managed-pointer type (ByRefTypeSymbol → T&) cannot
        // be encoded into a SignatureTypeEncoder slot because ELEMENT_TYPE_BYREF is a
        // parent-encoder concern. Callers in parameter / return / local positions must
        // request the byref form via the parent encoder (e.g. `ParameterTypeEncoder.Type(isByRef:true)`)
        // and then call EncodeTypeSymbol with the pointee type. The bug being fixed here
        // is that the previous code silently encoded `T&` as `T`, producing wrong CLR
        // signatures for `&T`-typed locals/fields/returns. Detect and fail loudly.
        if type is ByRefTypeSymbol byRef {
            throw InvalidOperationException(
                "Cannot encode '*${byRef.PointeeType.Name}' as a non-byref signature slot; " +
                    "use the parent encoder's Type(isByRef: true) overload (parameter/return/local) " +
                    "and pass the pointee type to EncodeTypeSymbol."
            )
        }
        // ADR-0186 §1: `T!` is erased at emit — its CLR signature is exactly
        // `T`'s, and there is no value-type case (§2: no `int32!`). Encoding
        // the UNDERLYING symbol, rather than falling through to the wrapper's
        // `ClrType` below, matters twice over: a G#-declared class (`Box!`,
        // `Box[string]!`) has no `ClrType` at all, and ADR-0186 §9 makes such
        // wrappers routine — every unadorned reference in an oblivious scope
        // is one — and a symbolic generic's `ClrType` is erased, so going
        // through it would drop the `Var`/`MVar` slots its arguments carry.
        if type is PlatformTypeSymbol platform {
            this.EncodeTypeSymbol(encoder, platform.UnderlyingType)
            return
        }
        // Phase 3 exit: `T?` for reference types is metadata-only (same CLR
        // signature as `T`). For value types it lowers to `Nullable<T>`.
        if type is NullableTypeSymbol nullable {
            let inner = nullable.UnderlyingType
            if inner is ImportedTypeSymbol symbolicValueType && symbolicValueType.OpenDefinition.IsValueTypeSafe() &&
                !symbolicValueType
                .TypeArguments
                .IsDefaultOrEmpty {
                let nullableOpen = typeof(System.Nullable[_])
                let genericNullable = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(nullableOpen),
                    genericArgumentCount: 1,
                    isValueType: true
                )
                this.EncodeTypeSymbol(genericNullable.AddArgument(), symbolicValueType)
                return
            }
            // P2-7 / Issue #421: nullable over a value type encodes as
            // System.Nullable<T> (generic instantiation). We support inner
            // types backed by a CLR value type (primitives, BCL value types).
            if inner?.ClrType is {} innerClrVt && innerClrVt.IsValueTypeSafe() {
                // Issue #571: build Nullable<T> from the open `System.Nullable`1`
                // discovered through the ReferenceResolver so it shares the load
                // context of the inner value type. See GetElementTypeToken.
                if !NullableLifting.TryConstructNullable(this.emitCtx.References, innerClrVt, out var nullableClr) {
                    throw InvalidOperationException(
                        "Cannot construct Nullable<${innerClrVt.FullName}>: System.Nullable`1 is not resolvable in the reference set."
                    )
                }
                this.EncodeClrType(encoder, nullableClr)
                return
            }
            // Issue #814 / ADR-0084 §L5: `T?` over an open type parameter
            // constrained to `struct` must encode as `GENERICINST System.Nullable`1<MVAR/VAR>`,
            // not as the bare `T` slot. Without this branch the struct-constrained
            // overload of `FirstOrNil`/`LastOrNil`/`SingleOrNil` emits a return
            // signature of `!!T` that, after instantiation with a value type,
            // becomes plain `int32` (etc.) — but the body assigns/returns a
            // `Nullable<T>` value, so the verifier rejects the mismatch and the
            // runtime mis-shapes the slot.  When the constraint is `class` the
            // CLR representation of `T?` coincides with `T` (a reference slot
            // that can hold `null`), so we keep the existing fall-through
            // to encode the bare type parameter.
            if inner is TypeParameterSymbol nullableTp && nullableTp.HasValueTypeConstraint {
                let nullableOpen = typeof(System.Nullable[_])
                let giNullable = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(nullableOpen),
                    genericArgumentCount: 1,
                    isValueType: true
                )
                this.EncodeTypeSymbol(giNullable.AddArgument(), nullableTp)
                return
            }
            if inner is TupleTypeSymbol nullableTuple {
                let giNullableTuple = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(typeof(System.Nullable[_])),
                    genericArgumentCount: 1,
                    isValueType: true
                )
                this.EncodeTypeSymbol(giNullableTuple.AddArgument(), nullableTuple)
                return
            }
            if inner is StructSymbol nestedStruct && !nestedStruct.IsClass {
                // Issue #1475: `S?` over a user-declared value-type struct
                // lowers to `System.Nullable<S>` — a generic instantiation
                // whose single argument is the struct's emitted TypeDef (or a
                // GENERICINST for a constructed user-generic struct). Mirrors
                // the user-enum branch below and the struct-constrained
                // type-parameter branch above.
                let nestedStructDef = nestedStruct.Definition ?? nestedStruct
                if !this.cache.StructTypeDefs.ContainsKey(nestedStructDef) {
                    throw InvalidOperationException("Struct '${nestedStruct.Name}' has no emitted TypeDef.")
                }
                let nullableOpenForStruct = typeof(System.Nullable[_])
                let giNullableStruct = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(nullableOpenForStruct),
                    genericArgumentCount: 1,
                    isValueType: true
                )
                this.EncodeTypeSymbol(giNullableStruct.AddArgument(), nestedStruct)
                return
            }
            if inner is EnumSymbol nestedEnum {
                // Issue #1298: `E?` over a user-declared enum lowers to
                // `System.Nullable<E>` — a generic instantiation whose single
                // argument is the enum's own emitted TypeDef. Mirrors the
                // struct-constrained type-parameter branch above.
                let nestedEnumDef = nestedEnum.Definition ?? nestedEnum
                if !this.cache.EnumTypeDefs.ContainsKey(nestedEnumDef) {
                    throw InvalidOperationException("Enum '${nestedEnum.Name}' has no emitted TypeDef.")
                }
                let nullableOpenForEnum = typeof(System.Nullable[_])
                let giNullableEnum = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(nullableOpenForEnum),
                    genericArgumentCount: 1,
                    isValueType: true
                )
                this.EncodeTypeSymbol(giNullableEnum.AddArgument(), nestedEnum)
                return
            }
            EncodeTypeSymbol(encoder, inner)
            return
        }
        if type == TypeSymbol.Bool {
            encoder.Boolean()
        } else if type == TypeSymbol.Int32 {
            encoder.Int32()
        } else if type == TypeSymbol.String {
            encoder.String()
        } else if type == TypeSymbol.Void {
            throw InvalidOperationException("Use ReturnTypeEncoder.Void() for void returns.")
        } else if type is TypeParameterSymbol tp {
            // Issue #810: when emitting a state-machine method (or the
            // state-machine class itself), references to the OUTER
            // method's type parameters are encoded as the SM class's
            // own type parameters (Var(i)). This mirrors how Roslyn
            // emits `<Empty>d__0<T>` where the body's `!!0` becomes
            // `!0` on the SM class. The remap is pushed by
            // EmitIteratorStateMachineMember and is keyed by the
            // source TP's instance identity.
            if this
                .remaps
                .ActiveIteratorStateMachineRemap != nil &&
                this
                .remaps
                .ActiveIteratorStateMachineRemap!!.TryGetValue(tp, out var classOrdinal) {
                encoder.GenericTypeParameter(classOrdinal)
            } else if this
                .remaps
                .ActiveLambdaMethodTypeParamRemap != nil &&
                this
                .remaps
                .ActiveLambdaMethodTypeParamRemap!!.TryGetValue(tp, out var lambdaMethodOrd) {
                encoder.GenericMethodTypeParameter(lambdaMethodOrd)
            } else if this
                .remaps
                .ActiveIteratorStateMachineRemap != nil &&
                this
                .remaps
                .ActiveIteratorStateMachineRemap!!.TryGetValue(tp, out var classOrdinal2) {
                encoder.GenericTypeParameter(classOrdinal2)
            } else if tp.IsMethodTypeParameter {
                encoder.GenericMethodTypeParameter(tp.Ordinal)
            } else {
                encoder.GenericTypeParameter(tp.Ordinal)
            }
        } else if type is ImportedTypeSymbol constructedImported &&
            !constructedImported
            .TypeArguments
            .IsDefaultOrEmpty &&
            constructedImported.OpenDefinition != nil {
            // Issue #2666: the cached CLR projection may be object-erased even
            // when every symbolic argument is concrete (for example the
            // KeyValuePair[K,V] cell captured by an async foreach body).
            let genericInst = encoder.GenericInstantiation(
                this.outer.memberRefs.GetTypeReference(constructedImported.OpenDefinition),
                constructedImported.TypeArguments.Length,
                isValueType: constructedImported.OpenDefinition.IsValueTypeSafe()
            )
            for arg in constructedImported.TypeArguments {
                this.EncodeTypeSymbol(genericInst.AddArgument(), arg)
            }
        } else if type is ArrayTypeSymbol arr {
            EncodeTypeSymbol(encoder.SZArray(), arr.ElementType)
        } else if type is RectangularArrayTypeSymbol rectangular {
            encoder.Array(out var elementEncoder, out var shapeEncoder)
            this.EncodeTypeSymbol(elementEncoder, rectangular.ElementType)
            shapeEncoder.Shape(
                rectangular.Rank,
                ImmutableArray[int32].Empty,
                Enumerable.Repeat(0, rectangular.Rank).ToImmutableArray()
            )
        } else if type is SliceTypeSymbol slice {
            EncodeTypeSymbol(encoder.SZArray(), slice.ElementType)
        } else if type is SequenceTypeSymbol openSeq {
            // Issue #773/#3412: encode every `sequence[T]` symbolically as
            // `GENERICINST<IEnumerable`1><T>` so the resulting method
            // signature never inherits an object-erased CLR projection for
            // nested same-compilation element types.
            let enumerableOpen = typeof(System.Collections.Generic.IEnumerable[_])
            let giSeq = encoder.GenericInstantiation(
                this.outer.memberRefs.GetTypeReference(enumerableOpen),
                1,
                isValueType: false
            )
            this.EncodeTypeSymbol(giSeq.AddArgument(), openSeq.ElementType)
        } else if type is AsyncSequenceTypeSymbol openAseq {
            // Mirror the synchronous symbolic encoding.
            let asyncEnumerableOpen = typeof(System.Collections.Generic.IAsyncEnumerable[_])
            let giAseq = encoder.GenericInstantiation(
                this.outer.memberRefs.GetTypeReference(asyncEnumerableOpen),
                1,
                isValueType: false
            )
            this.EncodeTypeSymbol(giAseq.AddArgument(), openAseq.ElementType)
        } else if type is StructSymbol structSym {
            if structSym.ClrType != nil {
                this.EncodeClrType(encoder, structSym.ClrType)
                return
            }
            // ADR-0087 §3 R2: a user-declared generic struct encodes as
            // GENERICINST<def><args>. For a constructed instance the args
            // come from TypeArguments; for the open definition itself we
            // emit the self-instantiation `Box`1<!0,!1,…>` so signatures
            // of synthesized members (Equals(typed), op_Equality, …)
            // round-trip correctly under verification.
            let defSym = structSym.Definition ?? structSym
            if !this.cache.StructTypeDefs.TryGetValue(defSym, out var typeDef) {
                throw InvalidOperationException("Struct '${defSym.Name}' has no emitted TypeDef.")
            }
            if ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym) {
                let typeArgs = this.outer.userTokens.ResolveUserStructTypeSpecArguments(structSym, defSym)
                let gi = encoder.GenericInstantiation(typeDef, typeArgs.Length, isValueType: !defSym.IsClass)
                for arg in typeArgs {
                    this.EncodeTypeSymbol(gi.AddArgument(), arg)
                }
            } else {
                encoder.Type(typeDef, isValueType: !structSym.IsClass)
            }
        } else if type is EnumSymbol enumSym {
            // Issue #193: a user-defined enum's signature surface is its
            // own TypeDef (a sealed value type derived from System.Enum).
            let enumDefSym = enumSym.Definition ?? enumSym
            if !this.cache.EnumTypeDefs.TryGetValue(enumDefSym, out var enumTypeDef) {
                throw InvalidOperationException("Enum '${enumSym.Name}' has no emitted TypeDef.")
            }
            if ReflectionMetadataEmitter.IsUserGenericEnumReference(enumSym) {
                let typeArgs = this.outer.userTokens.ResolveUserEnumTypeSpecArguments(enumSym, enumDefSym)
                let gi = encoder.GenericInstantiation(enumTypeDef, typeArgs.Length, isValueType: true)
                for arg in typeArgs {
                    this.EncodeTypeSymbol(gi.AddArgument(), arg)
                }
            } else {
                encoder.Type(enumTypeDef, isValueType: true)
            }
        } else if type is InterfaceSymbol ifaceSym {
            // Phase D: user-defined interface as a signature type. The
            // CLR encodes interfaces with the same CLASS bit as a reference
            // type (isValueType: false).
            //
            // ADR-0087 R5 / issue #765: when this is a constructed instance
            // of a user-declared generic interface (`IBox[int32]`), or the
            // open generic definition referenced as a signature type, emit
            // a GENERICINST against the definition's TypeDef. Mirrors the
            // StructSymbol branch above so member dispatch through
            // `let b IBox[int32] = …` (TypeSpec-parented MemberRef) and
            // signature encoding of an open `IBox[T]` parameter both
            // round-trip under IL verification.
            let ifaceDefSym = ifaceSym.Definition ?? ifaceSym
            if !this.cache.InterfaceTypeDefs.TryGetValue(ifaceDefSym, out var ifaceDef) {
                throw InvalidOperationException("Interface '${ifaceDefSym.Name}' has no emitted TypeDef.")
            }
            if ReflectionMetadataEmitter.IsUserGenericInterfaceReference(ifaceSym) {
                var ifaceTypeArgs ImmutableArray[TypeSymbol]
                if !ifaceSym.TypeArguments.IsDefaultOrEmpty {
                    ifaceTypeArgs = ifaceSym.TypeArguments
                } else {
                    let ifaceDefTps = ifaceDefSym.TypeParameters
                    let ifaceBld = ImmutableArray.CreateBuilder[TypeSymbol](ifaceDefTps.Length)
                    for defTp in ifaceDefTps {
                        ifaceBld.Add(defTp)
                    }
                    ifaceTypeArgs = ifaceBld.MoveToImmutable()
                }
                let ifaceGi = encoder.GenericInstantiation(ifaceDef, ifaceTypeArgs.Length, isValueType: false)
                for arg in ifaceTypeArgs {
                    this.EncodeTypeSymbol(ifaceGi.AddArgument(), arg)
                }
            } else {
                encoder.Type(ifaceDef, isValueType: false)
            }
        } else if type is DelegateTypeSymbol delegateSym {
            // ADR-0059 / issue #255: a user-declared named delegate type
            // encodes as a reference type referring to its own TypeDef
            // (a sealed class deriving from System.MulticastDelegate).
            // Issue #1503: a GENERIC named delegate encodes as
            // GENERICINST<Predicate`1><args> — for a constructed instance the
            // args come from TypeArguments; for the open definition the
            // self-instantiation `Predicate`1<!0,…>` is emitted so member
            // signatures round-trip under verification, exactly as the generic
            // struct/interface branches do.
            let delegateDefSym = delegateSym.Definition ?? delegateSym
            if !this.cache.DelegateTypeDefs.TryGetValue(delegateDefSym, out var delegateDef) {
                throw InvalidOperationException("Delegate '${delegateDefSym.Name}' has no emitted TypeDef.")
            }
            if delegateDefSym.TypeParameters.IsDefaultOrEmpty {
                encoder.Type(delegateDef, isValueType: false)
            } else {
                let delegateTypeArgs = ReflectionMetadataEmitter.ResolveDelegateTypeArguments(delegateSym)
                let gi = encoder.GenericInstantiation(delegateDef, delegateTypeArgs.Length, isValueType: false)
                for arg in delegateTypeArgs {
                    this.EncodeTypeSymbol(gi.AddArgument(), arg)
                }
            }
        } else if type is ChannelTypeSymbol chType {
            // ADR-0174 D2: chan[T] -> Channel<T>, in chan[T] -> ChannelReader<T>,
            // out chan[T] -> ChannelWriter<T>. Compiled metadata must retain
            // symbolic element identity under generic invariance.
            let channelOpen = ChannelTypeSymbol.OpenClrDefinition(chType.Direction)
            if MethodBodyEmitter.ChannelElementNeedsSymbolicType(chType.ElementType) {
                let genericInst = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(channelOpen),
                    1,
                    isValueType: false
                )
                this.EncodeTypeSymbol(genericInst.AddArgument(), chType.ElementType)
            } else {
                let elementClr = MethodBodyEmitter.ResolveChannelElementClrType(chType.ElementType)
                this.EncodeClrType(encoder, channelOpen.MakeGenericType(elementClr))
            }
        } else if type is TupleTypeSymbol tupleWithNullClr && tupleWithNullClr.ClrType == nil {
            // Issues #649/#2750: encode symbolic tuples recursively so arity
            // 8+ uses ValueTuple<T1,...,T7,TRest> without erasing elements.
            this.EncodeTupleType(encoder, tupleWithNullClr.ElementTypes, 0, tupleWithNullClr.Arity)
        } else if type is FunctionPointerTypeSymbol fnPtr {
            // ADR-0095 / issue #761: a raw function-pointer type encodes
            // as an ELEMENT_TYPE_FNPTR followed by a nested method
            // signature (calling convention + return + parameters). The
            // GS-level type is an address-sized integer at runtime, but
            // the metadata blob is rendered as FNPTR for type fidelity
            // so disassemblers and the verifier see the precise shape.
            // ADR-0095 v2 / issue #3611: the open model encodes
            // SignatureCallingConvention.Unmanaged (0x09) with the
            // CallConv{Name} types as return-type modopts in source order —
            // byte-identical to csc's `delegate* unmanaged[...]<...>`.
            let fnPtrConvention = FunctionPointerCallingConvention(fnPtr)
            let fnPtrSig = encoder.FunctionPointer(fnPtrConvention, FunctionPointerAttributes.None, 0)
            fnPtrSig.Parameters(fnPtr.ParameterTypes.Length, out var fnRetEnc, out var fnParamsEnc)
            this.EncodeCallConvModifiers(fnRetEnc, fnPtr)
            this.EncodeReturnSymbol(fnRetEnc, fnPtr.ReturnType)
            for var i = 0; i < fnPtr.ParameterTypes.Length; i++ {
                this.EncodeTypeSymbol(fnParamsEnc.AddParameter().Type(), fnPtr.ParameterTypes[i])
            }
        } else if type is FunctionTypeSymbol fn {
            // ADR-0087 §3 R6 / issue #2666: encode delegates from their symbolic shape.
            // A nested open slot (for example `async () -> T`) can still have
            // an object-erased ClrType (`Func<Task<object>>`); preferring that
            // cached projection corrupts generic async state-machine fields.
            // The reified signature retains the original nested Var/MVar slots.
            this.EncodeFunctionTypeSymbol(encoder, fn)
        } else if type?.ClrType != nil {
            this.EncodeClrType(encoder, type!!.ClrType)
        } else if type is MapTypeSymbol openMap {
            // Issue #1481: a `map[K, V]` whose erased CLR form is unavailable
            // because a key or value is (or structurally contains) an in-scope
            // type parameter — e.g. `map[string, T]` — has a null ClrType, so
            // the fast-path above cannot fire. Encode it as
            // `GENERICINST System.Collections.Generic.Dictionary`2<K, V>` with
            // each argument routed through EncodeTypeSymbol so the `Var`/`MVar`
            // slot survives. Without this the encoder threw
            // "Cannot encode signature for type 'map[string,T]'", so a generic
            // iterator yielding `map[string, T]` could not be emitted at all,
            // and the iterator's `IEnumerable<…>` / `IEnumerator<…>` rows could
            // not carry the strongly-typed `Dictionary<…, !0>` shape. The
            // matching body construction is reified through
            // <see cref="ImportedMemberRefFactory.GetMapCtorReference"/> /
            // <see cref="ImportedMemberRefFactory.GetMapSetItemReference"/>.
            let dictionaryOpen = typeof(System.Collections.Generic.Dictionary[_, _])
            let giMap = encoder.GenericInstantiation(
                this.outer.memberRefs.GetTypeReference(dictionaryOpen),
                genericArgumentCount: 2,
                isValueType: false
            )
            this.EncodeTypeSymbol(giMap.AddArgument(), openMap.KeyType)
            this.EncodeTypeSymbol(giMap.AddArgument(), openMap.ValueType)
        } else {
            throw NotSupportedException("Cannot encode signature for type '${type?.Name}' yet.")
        }
    }

    internal func EncodeTupleType(
        encoder SignatureTypeEncoder,
        elementTypes ImmutableArray[TypeSymbol],
        start int32,
        count int32
    ) {
        let physicalArity = if count <= 7 {
            count
        } else {
            8
        }
        let genericInst = encoder.GenericInstantiation(
            this.outer.memberRefs.GetTypeReference(TupleTypeSymbol.GetOpenClrType(physicalArity)),
            physicalArity,
            isValueType: true
        )
        let directCount = Math.Min(count, 7)
        for var i = 0; i < directCount; i++ {
            this.EncodeTypeSymbol(genericInst.AddArgument(), elementTypes[start + i])
        }
        if count > 7 {
            this.EncodeTupleType(genericInst.AddArgument(), elementTypes, start + 7, count - 7)
        }
    }

    /// ADR-0122 §9 / issue #1035: builds a standalone method signature for a
    /// function-pointer type, used as the operand of the CIL `calli`
    /// opcode. Managed function pointers use the default managed calling
    /// convention; unmanaged ones carry their declared ABI.
    /// @param fnPtr The function-pointer type to sign.
    /// @returns A standalone signature handle for `calli`.
    internal func GetFunctionPointerCallSiteSignature(fnPtr FunctionPointerTypeSymbol) StandaloneSignatureHandle {
        let convention = FunctionPointerCallingConvention(fnPtr)
        let sigBlob = BlobBuilder()
        let sig = BlobEncoder(sigBlob).MethodSignature(convention, 0, isInstanceMethod: false)
        sig.Parameters(fnPtr.ParameterTypes.Length, out var retEnc, out var paramsEnc)
        this.EncodeCallConvModifiers(retEnc, fnPtr)
        this.EncodeReturnSymbol(retEnc, fnPtr.ReturnType)
        for var i = 0; i < fnPtr.ParameterTypes.Length; i++ {
            this.EncodeTypeSymbol(paramsEnc.AddParameter().Type(), fnPtr.ParameterTypes[i])
        }
        return this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// ADR-0095 / issue #761: maps the
    /// (cref:System.Runtime.InteropServices.CallingConvention)
    /// enum (used by `@DllImport` / `@UnmanagedFunctionPointer`
    /// declarations and by (cref:FunctionPointerTypeSymbol)) to
    /// the metadata-level
    /// (cref:System.Reflection.Metadata.SignatureCallingConvention)
    /// enum used when encoding an ELEMENT_TYPE_FNPTR signature blob.
    ///
    /// ADR-0095 v2 / issue #3611: writes an open-model function pointer's
    /// `System.Runtime.CompilerServices.CallConv{Name}` types as
    /// optional custom modifiers on the return type, in source order — the
    /// blob position and order csc uses, so roundtripped signatures are
    /// byte-identical. No-op for managed, legacy, and bare
    /// (platform-default) pointers.
    /// @param returnTypeEncoder The FNPTR signature's return-type encoder.
    /// @param fnPtr The function-pointer type being encoded.
    private func EncodeCallConvModifiers(returnTypeEncoder ReturnTypeEncoder, fnPtr FunctionPointerTypeSymbol) {
        if !fnPtr.IsUnmanagedExtended || fnPtr.UnmanagedConventionClrTypes.IsDefaultOrEmpty {
            return
        }
        var modifiers = returnTypeEncoder.CustomModifiers()
        for callConvType in fnPtr.UnmanagedConventionClrTypes {
            modifiers = modifiers.AddModifier(this.outer.memberRefs.GetTypeReference(callConvType), isOptional: true)
        }
    }

    private func EncodeReturnSymbol(encoder ReturnTypeEncoder, type TypeSymbol) -> EncodeReturnSymbol(
        encoder,
        type,
        RefKind.None
    )

    /// Issue #490 (ADR-0060 follow-up): a function whose (cref:FunctionSymbol.ReturnRefKind)
    /// is (cref:RefKind.Ref) returns a managed pointer (`T&`) — encode it via
    /// the `ReturnTypeEncoder.Type(isByRef: true, ...)` overload.
    internal func EncodeReturnSymbol(encoder ReturnTypeEncoder, type TypeSymbol, returnRefKind RefKind) {
        if type == TypeSymbol.Void {
            encoder.Void()
        } else {
            if returnRefKind == RefKind.RefReadOnly {
                encoder.CustomModifiers().AddModifier(this.outer.wellKnown.GetInAttributeTypeRef(), isOptional: false)
            }
            this.EncodeTypeSymbol(encoder.Type(isByRef: returnRefKind != RefKind.None), type)
        }
    }

    internal func EncodeClrType(encoder SignatureTypeEncoder, type Type?) {
        if type is {IsFunctionPointer: true} functionPointer {
            this.EncodeTypeSymbol(
                encoder,
                FunctionPointerTypeSymbol.FromClrSignature(
                    functionPointer,
                    (position Type) -> TypeSymbol.FromClrTypeWithoutNullability(
                        position,
                        NullabilityFreeReason.TypeStructure
                    )
                )
            )
            return
        }
        // ADR-0060 §13 / migration: same as EncodeTypeSymbol — a CLR `T&` (Type.IsByRef)
        // cannot be encoded into a SignatureTypeEncoder slot. Callers must arrange the
        // byref form via the parent encoder. Detect and fail loudly so the previously
        // silent miscoding shows up as an emit-time error.
        if type != nil && type.IsByRef {
            throw InvalidOperationException(
                "Cannot encode CLR byref type '${type.FullName}' as a non-byref signature slot; " +
                    "use the parent encoder's Type(isByRef: true) overload and pass the element type to EncodeClrType."
            )
        }
        // ADR-0122 / issue #1014: a CLR unmanaged pointer (`T*`, Type.IsPointer)
        // encodes with the `*` element-type prefix followed by the element type.
        if type != nil && type.IsPointer {
            EncodeClrType(encoder.Pointer(), type.GetElementType()!!)
            return
        }
        // Compare by FullName so types from a MetadataLoadContext (carrying the target
        // framework's identity) still encode to the same well-known primitive opcodes.
        let fullName = type?.FullName
        switch fullName {
            case "System.Boolean" {
                encoder.Boolean()
            }
            case "System.Byte" {
                encoder.Byte()
            }
            case "System.SByte" {
                encoder.SByte()
            }
            case "System.Int16" {
                encoder.Int16()
            }
            case "System.UInt16" {
                encoder.UInt16()
            }
            case "System.Int32" {
                encoder.Int32()
            }
            case "System.UInt32" {
                encoder.UInt32()
            }
            case "System.Int64" {
                encoder.Int64()
            }
            case "System.UInt64" {
                encoder.UInt64()
            }
            case "System.Single" {
                encoder.Single()
            }
            case "System.Double" {
                encoder.Double()
            }
            case "System.Char" {
                encoder.Char()
            }
            case "System.String" {
                encoder.String()
            }
            case "System.Object" {
                encoder.Object()
            }
            case "System.IntPtr" {
                encoder.IntPtr()
            }
            case "System.UIntPtr" {
                encoder.UIntPtr()
            }
            case "System.Void" {
                // ADR-0124 / issue #1024: `void*` (the first parameter of
                // `Span<T>(void* pointer, int length)`) encodes as PTR VOID.
                // The pointer prefix is written by the parent `encoder.Pointer()`
                // call (see the IsPointer branch above); here we emit the raw
                // ELEMENT_TYPE_VOID for the pointee. SignatureTypeEncoder has no
                // Void() helper (void is only valid as a return or pointee), so
                // write the type-code byte directly.
                encoder.Builder.WriteByte(uint8(SignatureTypeCode.Void))
            }
            default {
                if type == nil {
                    throw NotSupportedException("Cannot encode signature for a null CLR type.")
                }
                if type.IsGenericParameter {
                    // Method signatures reference declaring-type generic params as `!N`
                    // and declaring-method generic params as `!!N` (Phase E adds method
                    // generic support for calls like `Channel.CreateUnbounded<T>()`).
                    if type.DeclaringMethod != nil {
                        encoder.GenericMethodTypeParameter(type.GenericParameterPosition)
                    } else {
                        encoder.GenericTypeParameter(type.GenericParameterPosition)
                    }
                    break
                }
                if type.IsArray && type.GetArrayRank() == 1 {
                    EncodeClrType(encoder.SZArray(), type.GetElementType()!!)
                    break
                }
                if type.IsArray {
                    encoder.Array(out var elementEncoder, out var shapeEncoder)
                    // IsArray check above establishes a non-null reflection element type.
                    EncodeClrType(elementEncoder, type.GetElementType()!!)
                    shapeEncoder.Shape(
                        type.GetArrayRank(),
                        ImmutableArray[int32].Empty,
                        Enumerable.Repeat(0, type.GetArrayRank()).ToImmutableArray()
                    )
                    break
                }
                if type.IsConstructedGenericType {
                    let openDef = type.GetGenericTypeDefinition()
                    let typeArgs = type.GetGenericArguments()
                    let genericInst = encoder.GenericInstantiation(
                        this.outer.memberRefs.GetTypeReference(openDef),
                        typeArgs.Length,
                        isValueType: openDef.IsValueTypeSafe()
                    )
                    for arg in typeArgs {
                        EncodeClrType(genericInst.AddArgument(), arg)
                    }
                    break
                }
                // A generic type definition used as a return/parameter type in an
                // open method signature (e.g. AsyncTaskMethodBuilder<TResult>.Create()
                // returning AsyncTaskMethodBuilder<TResult>). The reflection type is
                // the generic type definition itself, but it must encode as a
                // GenericInstantiation with its own type parameters as arguments.
                if type.IsGenericTypeDefinition {
                    let typeParams = type.GetGenericArguments()
                    let genericInst = encoder.GenericInstantiation(
                        this.outer.memberRefs.GetTypeReference(type),
                        typeParams.Length,
                        isValueType: type.IsValueTypeSafe()
                    )
                    for tp in typeParams {
                        EncodeClrType(genericInst.AddArgument(), tp)
                    }
                    break
                }
                // Issue #3764: the value-type flag written here is the
                // difference between ELEMENT_TYPE_VALUETYPE and
                // ELEMENT_TYPE_CLASS in the emitted signature, and the raw
                // `Type.IsValueType` answers `false` for a struct that reached
                // the compilation from outside its MetadataLoadContext's core
                // assembly. ILVerify resolves the TypeRef by name and accepts
                // the result; the runtime does not, and rejects the assembly
                // with "value type mismatch" at first use.
                encoder.Type(this.outer.memberRefs.GetTypeReference(type), isValueType: type.IsValueTypeSafe())
            }
        }
    }

    internal func EncodeParameterClr(encoder ParameterTypeEncoder, parameter ParameterInfo) {
        let modifiers = encoder.CustomModifiers()
        for modifier in parameter.GetRequiredCustomModifiers() {
            modifiers.AddModifier(this.outer.memberRefs.GetTypeReference(modifier), isOptional: false)
        }
        for modifier in parameter.GetOptionalCustomModifiers() {
            modifiers.AddModifier(this.outer.memberRefs.GetTypeReference(modifier), isOptional: true)
        }
        let type = ClrNullability.GetSignatureType(parameter)
        // IsByRef guarantees reflection supplies the parameter's element type.
        this.EncodeClrType(
            encoder.Type(isByRef: type.IsByRef),
            if type.IsByRef {
                type.GetElementType()
            } else {
                type
            }
        )
    }

    internal func EncodeReturnClr(encoder ReturnTypeEncoder, returnParameter ParameterInfo, type Type?) {
        var type = type
        if type != nil {
            type = ClrNullability.GetSignatureType(returnParameter)
        }
        if type?.FullName == "System.Void" {
            // Issue #522: a void return may still carry required custom
            // modifiers — most notably C# 9 init-only property setters emit
            // `modreq(System.Runtime.CompilerServices.IsExternalInit)` on the
            // setter's void return. The modreq is part of the method
            // signature; if we omit it the MemberRef fails to resolve at
            // runtime (System.MissingMethodException). Mirrors the byref
            // branch below — encode modreqs first, then the void slot.
            let voidRequiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes
            if voidRequiredModifiers.Length > 0 {
                let modifiers = encoder.CustomModifiers()
                for modifier in voidRequiredModifiers {
                    modifiers.AddModifier(this.outer.memberRefs.GetTypeReference(modifier), isOptional: false)
                }
            }
            encoder.Void()
        } else if type != nil && type.IsByRef {
            // ADR-0056 §1/§2: a `ref`/`ref readonly T` return (e.g. the span
            // indexer's `get_Item`) must encode as a managed pointer to the
            // pointee. A `ref readonly T` return additionally carries a required
            // custom modifier (`modreq(InAttribute)` on `ReadOnlySpan[T]`); it
            // must be encoded or the methodref signature fails to resolve at
            // runtime (MissingMethodException). Without `isByRef: true` the
            // return was malformed for every ref-returning member.
            let requiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes
            if requiredModifiers.Length > 0 {
                let modifiers = encoder.CustomModifiers()
                for modifier in requiredModifiers {
                    modifiers.AddModifier(this.outer.memberRefs.GetTypeReference(modifier), isOptional: false)
                }
            }
            this.EncodeClrType(encoder.Type(isByRef: true), type.GetElementType()!!)
        } else {
            this.EncodeClrType(encoder.Type(), type)
        }
    }

    /// Issue #295: map an arbitrary CLR delegate type (named or generic, e.g.
    /// `System.Predicate<int>`, `RequestDelegate`,
    /// `System.EventHandler`) from the host runtime onto the emitter's
    /// reference (MetadataLoadContext) types, reconstructing constructed
    /// generics from a reference open definition so the produced TypeSpec /
    /// MemberRef binds to the target framework assemblies. Falls back to the
    /// host type when no reference mapping is available.
    ///
    /// Issue #2325: this used to carry its own constructed-generic remapping
    /// loop, separate from (and ahead of) the one in
    /// (cref:MapToReferenceClrType) — which only did a flat
    /// full-name lookup and therefore could not resolve a constructed generic
    /// argument (e.g. the inner `Action<object>` of
    /// `Action<Action<object>, object>`). That let a nested/
    /// higher-order delegate mix a MetadataLoadContext open definition with a
    /// host-context type argument, which `MakeGenericType` rejects at emit
    /// time (GS9998). `MapToReferenceClrType` now performs the same recursive
    /// remapping itself, so both callers share one implementation.
    /// @remarks Falls back to [`hostDelegate`](paramref) when the reference set has
    /// no matching type, exactly as every other (cref:MapToReferenceClrType)
    /// caller does: an unmappable delegate is still a delegate the emitter must
    /// reference, and both callers here feed the result straight into a
    /// MemberRef/TypeRef that a null would only turn into a null dereference.
    /// Issue #4381: a delegate already loaded from a supplied reference keeps
    /// that exact identity because another assembly may define the same full
    /// name. Only host-fallback types need projection into the target context.
    internal func ResolveTargetDelegateClrType(hostDelegate Type) Type {
        let hostDefinition = if hostDelegate.IsConstructedGenericType {
            hostDelegate.GetGenericTypeDefinition()
        } else {
            hostDelegate
        }
        if !this.emitCtx.References.IsHostFallback(hostDefinition) {
            return hostDelegate
        }
        return this.MapToReferenceClrType(hostDelegate) ?? hostDelegate
    }

    // Phase 4 emit parity (E1): resolve the BCL delegate type backing a
    // GSharp function type. The default ClrType on FunctionTypeSymbol uses
    // host-runtime `typeof(Func<,>)` (which lives in System.Private.CoreLib);
    // the emitter must instead reference the *target* framework's
    // System.Func / System.Action so the produced TypeRef binds to the right
    // assembly. Type arguments are resolved through references too so
    // signature encoding stays consistent end-to-end.
    internal func ResolveDelegateClrType(fnType FunctionTypeSymbol) Type {
        let isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType)
        let arity = fnType.ParameterTypes.Length
        if isVoid && arity == 0 {
            return this.emitCtx.References.GetCoreType("System.Action")
        }
        let typeName = if isVoid {
            "System.Action`" + arity.ToString(CultureInfo.InvariantCulture)
        } else {
            "System.Func`" + (arity + 1).ToString(CultureInfo.InvariantCulture)
        }
        let openDef = this.emitCtx.References.GetCoreType(typeName)
        let args = [
            arity +
                (
                if isVoid {
                    0
                } else {
                    1
                }
            )
        ]Type
        for var i = 0; i < arity; i++ {
            args[i] = this.ResolveDelegateArgClrType(fnType.ParameterTypes[i])
        }
        if !isVoid {
            args[arity] = this.ResolveDelegateArgClrType(fnType.ReturnType)
        }
        return openDef.MakeGenericType(args)
    }

    // Resolve the CLR type used as a System.Func/System.Action type argument
    // for one delegate parameter or return TypeSymbol. ADR-0087 §3 R6: under
    // the reified model, a type-parameter slot must not appear here — the
    // signature encoder takes the symbolic path
    // (<see cref="EncodeFunctionTypeSymbol"/>) and the body emitter routes
    // delegate ctor / Invoke through MemberRefs parented at the reified
    // TypeSpec. Any caller that still passes a type-parameter-bearing type
    // is a missed conversion site and worth surfacing.
    private func ResolveDelegateArgClrType(type TypeSymbol) Type {
        // Issue #1518: a nullable value-type slot (T?) must materialise as
        // Nullable<T> on the delegate shape, not the bare underlying T. The
        // symbol's ClrType is the bare underlying, so lift through
        // NullableLifting.GetEffectiveClrType (identity for everything else)
        // to keep the emitted Func/Action delegate in agreement with the
        // instantiation overload-resolution inferred.
        return this.MapToReferenceClrType(NullableLifting.GetEffectiveClrType(type)) ?? this.emitCtx.CoreObjectType
    }

    /// ADR-0087 §3 R6: encodes a (cref:FunctionTypeSymbol) whose
    /// shape carries type-parameter slots (e.g. `func(T) U`) as a
    /// reified `GENERICINST<Func`N or Action`N><args>`
    /// blob. Each argument is encoded recursively through
    /// (cref:EncodeTypeSymbol), so type parameters resolve to the
    /// proper `Var(idx)` / `MVar(idx)` slots.
    internal func EncodeFunctionTypeSymbol(encoder SignatureTypeEncoder, fnType FunctionTypeSymbol) {
        let isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType)
        let arity = fnType.ParameterTypes.Length
        if isVoid && arity == 0 {
            let actionType = this.emitCtx.References.GetCoreType("System.Action")
            this.EncodeClrType(encoder, actionType)
            return
        }
        let typeName = if isVoid {
            "System.Action`" + arity.ToString(CultureInfo.InvariantCulture)
        } else {
            "System.Func`" + (arity + 1).ToString(CultureInfo.InvariantCulture)
        }
        let openDef = this.emitCtx.References.GetCoreType(typeName)
        let openHandle = this.outer.memberRefs.GetTypeReference(openDef)
        let typeArgCount = arity +
            (
            if isVoid {
                0
            } else {
                1
            }
        )
        let gi = encoder.GenericInstantiation(openHandle, typeArgCount, isValueType: openDef.IsValueTypeSafe())
        for var i = 0; i < arity; i++ {
            this.EncodeTypeSymbol(gi.AddArgument(), fnType.ParameterTypes[i])
        }
        if !isVoid {
            this.EncodeTypeSymbol(gi.AddArgument(), fnType.ReturnType)
        }
    }

    /// For an async lambda, resolves the delegate CLR type matching the kickoff
    /// method signature: Task/Task<T> for ordinary async, or Action for
    /// explicit async void.
    internal func ResolveAsyncDelegateClrType(fnType FunctionTypeSymbol, function FunctionSymbol) Type {
        // Find the async plan for this function.
        var plan AsyncStateMachinePlan? = nil
        for p in this.outer.stateMachines.AsyncStateMachinePlans {
            if p.KickoffMethod == function {
                plan = p
                break
            }
        }
        if plan == nil {
            return this.ResolveDelegateClrType(fnType)
        }
        let builderInfo = plan.StateMachine.BuilderInfo
        if builderInfo.Kind == AsyncMethodBuilderKind.Void {
            return this.ResolveDelegateClrType(fnType)
        }
        var taskClrType Type
        if builderInfo.TaskProperty != nil {
            taskClrType = builderInfo.TaskProperty.PropertyType
        } else {
            taskClrType = typeof(Task)
        }
        let arity = fnType.ParameterTypes.Length
        let typeName = "System.Func`" + (arity + 1).ToString(CultureInfo.InvariantCulture)
        let openDef = this.emitCtx.References.GetCoreType(typeName)
        let args = [arity + 1]Type
        for var i = 0; i < arity; i++ {
            args[i] = this.MapToReferenceClrType(fnType.ParameterTypes[i].ClrType) ?? Invariant.Required(
                fnType.ParameterTypes[i].ClrType,
                "a function parameter has a CLR representation",
                expression: "fnType.ParameterTypes[i].ClrType"
            )
        }
        args[arity] = this.MapToReferenceClrType(taskClrType) ?? taskClrType
        return openDef.MakeGenericType(args)
    }

    // Map a host-runtime Type onto the MetadataLoadContext type from the
    // emitter's references when an equivalent exists. Returns the input
    // unchanged when no mapping is found — non-primitive host types whose
    // FullName isn't resolvable will keep their original identity (and may
    // still encode fine via EncodeClrType's primitive matching).
    //
    // Issue #2325: this is the single recursive reference-context remapper
    // shared by every caller that needs to cross from host-runtime `Type`s
    // to the emitter's MetadataLoadContext `Type`s (ResolveDelegateArgClrType,
    // ResolveTargetDelegateClrType, ResolveAsyncDelegateClrType, and the
    // event-handler-type lookups in MethodBodyEmitter.Closures.cs). A
    // *constructed* generic type — e.g. `Action<object>`, or nested/
    // higher-order shapes like `Action<Action<object>, object>` — cannot be
    // resolved by the flat `Type.FullName` lookup below: `FullName` on a
    // constructed generic type embeds each argument's assembly-qualified
    // name (e.g. "System.Action`1[[System.Object, ...]]"), which never
    // matches the reference index (built from open generic *definitions*
    // only — see AddToTypeNameIndex). Left unhandled, a constructed generic
    // delegate argument fell through to the "return hostType unchanged"
    // fallback, and a later `MakeGenericType` on a reference-context open
    // definition mixed in a host-context type argument — MakeGenericType
    // rejects that combination at emit time (GS9998: "was not loaded by the
    // MetadataLoadContext that loaded the generic type or method").
    //
    // The fix: resolve the open generic definition through the active
    // reference context, then recurse into every type argument through this
    // same helper — so an arbitrarily nested constructed generic (the
    // higher-order delegate case) is remapped, and the closed type is
    // constructed entirely within the reference context. Non-generic types
    // keep the original flat lookup; an open definition with no reference
    // equivalent falls back to the host type unchanged, same as before.
    //
    // Issue #2325 follow-up: an array (`T[]`/`T[,]`), pointer (`T*`), or
    // byref (`T&`) shape can appear as (or nested inside — e.g.
    // `Action<int[], object>`) a constructed generic argument, and is
    // subject to the exact same cross-context mismatch: `T.MakeArrayType()`
    // / `MakePointerType()` / `MakeByRefType()` built over an unmapped
    // host-context element `Type` still carries the host identity, so a
    // later `MakeGenericType` combining it with a reference-context open
    // definition throws GS9998 the same way an unmapped constructed generic
    // argument did. Each of these three shapes wraps exactly one element
    // type (`Type.GetElementType()`), so recurse through this same helper on
    // the element and rebuild the wrapper — preserving the exact array rank
    // (and the vector- vs. general-rank-1-array distinction, via
    // `Type.IsSZArray`) — entirely within the reference context. An element
    // that is itself a `Type.IsGenericParameter` (e.g. `T[]` for an in-scope
    // type parameter) falls through unchanged via the flat lookup below,
    // exactly as an unwrapped generic parameter already did: this rebuild
    // only changes how the *wrapper* is reconstructed, not generic-parameter
    // handling.
    internal func MapToReferenceClrType(hostType Type?) Type? {
        if hostType == nil {
            return nil
        }
        if hostType.IsByRef {
            let element = Invariant.Required(
                hostType.GetElementType(),
                "a by-ref, pointer or array type always has an element type",
                expression: "hostType.GetElementType()"
            )
            let mappedElement = this.MapToReferenceClrType(element) ?? element
            return mappedElement.MakeByRefType()
        }
        if hostType.IsPointer {
            let element = Invariant.Required(
                hostType.GetElementType(),
                "a by-ref, pointer or array type always has an element type",
                expression: "hostType.GetElementType()"
            )
            let mappedElement = this.MapToReferenceClrType(element) ?? element
            return mappedElement.MakePointerType()
        }
        if hostType.IsArray {
            let element = Invariant.Required(
                hostType.GetElementType(),
                "a by-ref, pointer or array type always has an element type",
                expression: "hostType.GetElementType()"
            )
            let mappedElement = this.MapToReferenceClrType(element) ?? element
            // A rank-1 array is either a vector (`T[]`, constructed via the
            // parameterless `MakeArrayType()`) or a general rank-1 array
            // (`T[*]`, constructed via `MakeArrayType(1)`) — reflection
            // treats these as distinct array kinds sharing rank 1;
            // `Type.IsSZArray` is the documented way to tell them apart
            // (mirrors DocumentationIdProvider.AppendArraySuffix).
            return if hostType.IsSZArray {
                mappedElement.MakeArrayType()
            } else {
                mappedElement.MakeArrayType(hostType.GetArrayRank())
            }
        }
        if hostType.IsConstructedGenericType {
            let openDef = hostType.GetGenericTypeDefinition()
            if openDef.FullName != nil &&
                this
                .emitCtx
                .References
                .TryResolveType(openDef.FullName!!, requireExternalVisibility: false, out var openRef) {
                let hostArgs = hostType.GetGenericArguments()
                let refArgs = [hostArgs.Length]Type
                for var i = 0; i < hostArgs.Length; i++ {
                    refArgs[i] = this.MapToReferenceClrType(hostArgs[i]) ?? hostArgs[i]
                }
                return openRef!!.MakeGenericType(refArgs)
            }
            return hostType
        }
        if this
            .emitCtx
            .References
            .TryResolveType(hostType.FullName ?? hostType.Name, requireExternalVisibility: false, out var mapped) {
            return mapped!!
        }
        return hostType
    }

    shared {
        private func FunctionPointerCallingConvention(pointer FunctionPointerTypeSymbol) SignatureCallingConvention {
            if pointer.IsManaged {
                return SignatureCallingConvention.Default
            }
            return if pointer.IsUnmanagedExtended {
                SignatureCallingConvention.Unmanaged
            } else {
                MapToSignatureCallingConvention(pointer.CallingConvention)
            }
        }

        private func MapToSignatureCallingConvention(convention CallingConvention) SignatureCallingConvention {
            return switch convention {
                case CallingConvention.Cdecl: SignatureCallingConvention.CDecl
                case CallingConvention.StdCall: SignatureCallingConvention.StdCall
                case CallingConvention.ThisCall: SignatureCallingConvention.ThisCall
                case CallingConvention.FastCall: SignatureCallingConvention.FastCall
                case CallingConvention.Winapi: SignatureCallingConvention.StdCall
                default: SignatureCallingConvention.CDecl
            }
        }
    }
}
