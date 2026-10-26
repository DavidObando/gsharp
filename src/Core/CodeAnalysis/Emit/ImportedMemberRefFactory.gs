// <copyright file="ImportedMemberRefFactory.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis

/// PR-E-18 (#1361): the imported / BCL member-and-type reference factory band.
/// Owns every method that renders an external (reference-context / BCL) type,
/// method, constructor, or field into an ECMA-335 `TypeRef` /
/// `TypeSpec` / `MemberRef` / `MethodSpec` row — the token
/// producers the body emitter and its collaborators call to reference the
/// outside world. Covers the element/typeof/assembly/type-reference resolvers
/// (`GetElementTypeToken`, `GetTypeOfToken`,
/// `GetTypeReference`, `GetTypeHandleForMember`, the
/// `System.Runtime` facade assembly-ref), the method / ctor / field
/// MemberRef factories (`GetMethodReference`,
/// `GetMethodEntityHandle`, `GetCtorReference`,
/// `GetFieldReference` and the constructed-generic variants), the
/// symbolic-user-type-argument nullable / tuple / map MemberRef families, and
/// the reified `Func`/`Action` delegate MemberRef producers, plus the
/// open-definition / TypeBuilder-safe reflection helpers they share.
/// @remarks This is the near-pure move the decomposition plan flagged: the state these
/// factories dedup against already lives on (cref:MetadataTokenCache)
/// (moved in PR-E-2), so every ref-cache dictionary is reached via
/// (cref:cache) and no metadata state relocates here. The only fields
/// that move with the band are the three reified-delegate-shape caches
/// (`functionDelegate*Cache`), which were RME privates consumed solely by
/// the delegate MemberRef producers.
///
/// Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// SignatureEncoder idiom) because the band reaches
/// (cref:EmitContext), (cref:MetadataTokenCache),
/// (cref:GenericRemapState), the extracted
/// (cref:SignatureEncoder) (signature/type encoding), the
/// (cref:StateMachineEmitter) plans, AND several user-token resolvers
/// that only move in PR-E-19
/// ((cref:UserTokenResolver.GetUserStructTypeSpec),
/// (cref:UserTokenResolver.GetUserInterfaceTypeSpec),
/// (cref:UserTokenResolver.FunctionTypeNeedsSymbolicDelegate)).
/// Those temporary couplings are reached through (cref:outer) and are
/// resolved when the user-token-resolution band is extracted (E-19). Direct
/// convenience fields hold the shared (cref:EmitContext) /
/// (cref:MetadataTokenCache) / (cref:GenericRemapState) /
/// (cref:SignatureEncoder) read off the back-reference. Method bodies
/// are verbatim moves; emitted PEs are byte-identical with the pre-E-18
/// baseline.
internal class ImportedMemberRefFactory {
    private let outer ReflectionMetadataEmitter
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let remaps GenericRemapState
    private let signatures SignatureEncoder

    init(outer ReflectionMetadataEmitter) {
        this.outer = outer ?? throw ArgumentNullException("outer")
        this.emitCtx = outer.emitCtx
        this.cache = outer.cache
        this.remaps = outer.remaps
        this.signatures = outer.signatures ?? throw ArgumentNullException("outer")
    }

    /// Issue #4938: the token for an opcode that names a type's exact
    /// identity rather than a value's runtime type: the array-element opcodes
    /// (`newarr`, `ldelem`, `stelem`, `ldelema`) and `ldtoken` for
    /// `typeof(T)`. An array must match its `T[]` signature, and `typeof`
    /// must reflect the written type. For a function pointer that is the
    /// FNPTR TypeSpec: `newarr System.IntPtr` would create an `IntPtr[]`
    /// where the signature says `method …*[]` (issue #4684), and
    /// `typeof(unmanaged[CC] () -> R)` is a function-pointer `Type`
    /// (`IsFunctionPointer`), not `IntPtr`. Every other type tokenises
    /// exactly as (cref:GetElementTypeToken) does, which gives a function
    /// pointer its runtime projection, `System.IntPtr`.
    /// @param element The type to name.
    /// @returns The type token.
    internal func GetExactTypeToken(element TypeSymbol) EntityHandle {
        if element is PlatformTypeSymbol platformElement {
            return this.GetExactTypeToken(platformElement.UnderlyingType)
        }
        if element is FunctionPointerTypeSymbol {
            let sigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), element)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        return this.GetElementTypeToken(element)
    }

    internal func GetElementTypeToken(element TypeSymbol) EntityHandle {
        // ADR-0186 §1: `T!` is erased at emit and has no value-type case, so
        // its token is exactly `T`'s. Tokenising the UNDERLYING symbol matters
        // for a G#-declared type, which has no `ClrType` for the fallback
        // below to use — and ADR-0186 §9 makes a platform-wrapped G# class
        // routine (`var t Tag` in an oblivious scope is `Tag!`).
        if element is PlatformTypeSymbol platformElement {
            return this.GetElementTypeToken(platformElement.UnderlyingType)
        }
        // P2-7 / Issue #421: nullable over a value type tokenises as
        // System.Nullable<T>. NullableTypeSymbol over a reference type
        // continues to share the underlying CLR type (handled below by
        // the `element.ClrType != null` branch via the NullableTypeSymbol
        // ctor that copies `underlying.ClrType`).
        if element is NullableTypeSymbol nullableElement && !NullableLifting.RequiresSymbolicNullableGetValue(
            nullableElement
        ) &&
            nullableElement
            .UnderlyingType
            ?.ClrType is {IsValueType: true} nullableInnerClr {
            // Issue #571: route Nullable<T> through the ReferenceResolver so the
            // open definition and the (possibly MLC-backed) inner come from the
            // same load context. The host `typeof(System.Nullable<>)` mixes
            // contexts and trips GS9998 inside the TypeBuilder/MetadataBuilder
            // ctor/member-reference paths.
            if !NullableLifting.TryConstructNullable(this.emitCtx.References, nullableInnerClr, out var nullableClr) {
                throw InvalidOperationException(
                    "Cannot construct Nullable<${nullableInnerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
                )
            }
            return this.GetTypeHandleForMember(nullableClr)
        }
        // Issue #814 / ADR-0084 §L5: `T?` over an open type parameter.
        // For `[T struct]` the storage shape is `Nullable<!!T>`, encoded
        // as a TypeSpec naming the generic instantiation; this is the
        // token consumed by `initobj` when zero-initialising the slot.
        // For `[T class]` the storage shape is the bare `!!T` (a reference
        // slot that holds `null`), so we forward to the existing
        // TypeParameterSymbol branch by recursing on the underlying.
        if element is NullableTypeSymbol nullableTpElement &&
            nullableTpElement.UnderlyingType is TypeParameterSymbol nullableTpInner {
            if nullableTpInner.HasValueTypeConstraint {
                let sigBlob = BlobBuilder()
                this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), nullableTpElement)
                return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
            }
            return this.GetElementTypeToken(nullableTpInner)
        }
        // Issue #1298: `E?` over a user-declared enum tokenises as a TypeSpec
        // naming the generic instantiation `System.Nullable<E>`. This is the
        // token consumed by `box Nullable<E>` in the lifted enum-equality emit
        // (and by `initobj` when zero-initialising such a slot).
        //
        // Issues #1475/#3088: the same TypeSpec form applies to any symbolic
        // value-type underlying, including a tuple whose nullable-reference
        // elements suppress its direct ClrType.
        if element is NullableTypeSymbol nullableUserVtElement && NullableLifting.RequiresSymbolicNullableGetValue(
            nullableUserVtElement
        ) &&
            !(nullableUserVtElement.UnderlyingType is TypeParameterSymbol) {
            let sigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), nullableUserVtElement)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        // Issue #2498: nullable-reference annotations do not change the CLR
        // element token. Forward same-compilation classes/interfaces/delegates
        // through their underlying symbol just as imported nullable references
        // already flow through the shared CLR Type.
        if element is NullableTypeSymbol nullableReferenceElement && !NullableLifting.IsAnyValueTypeNullable(
            nullableReferenceElement
        ) {
            return this.GetElementTypeToken(nullableReferenceElement.UnderlyingType)
        }
        if element == TypeSymbol.Int32 {
            return this.GetTypeReference(this.emitCtx.CoreInt32Type)
        }
        if element == TypeSymbol.Bool {
            return this.GetTypeReference(this.emitCtx.CoreBooleanType)
        }
        if element == TypeSymbol.String {
            return this.GetTypeReference(this.emitCtx.CoreStringType)
        }
        // Issue #3285 sibling sweep: an unmanaged pointer needs its PTR
        // TypeSpec. A TypeRef whose name is `System.Int32*` is not a real
        // runtime type and fails to load.
        if element is PointerTypeSymbol {
            let sigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), element)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        // Issue #4938: a function pointer tokenises as its runtime projection,
        // `System.IntPtr`. The CLR has no boxed function-pointer type, so the
        // opcodes that act on a value's runtime type (`box`, `isinst`,
        // `unbox.any`, `castclass`) must name `IntPtr`: with the FNPTR TypeSpec
        // `box` produced nil and `isinst` never matched, so `x as
        // (unmanaged[CC] () -> R)?` silently yielded nil and `x is …` false.
        // Only the opcodes that name a type's identity (array elements,
        // `typeof`) need the exact FNPTR type; they use GetExactTypeToken.
        if element is FunctionPointerTypeSymbol {
            return this.GetElementTypeToken(TypeSymbol.NInt)
        }
        if element is ArrayTypeSymbol nestedArr {
            let sigBlob = BlobBuilder()
            let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
            this.signatures.EncodeTypeSymbol(encoder, nestedArr)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        if element is RectangularArrayTypeSymbol nestedRectangular {
            let sigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), nestedRectangular)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        if element is SliceTypeSymbol nestedSlice {
            let sigBlob = BlobBuilder()
            let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
            this.signatures.EncodeTypeSymbol(encoder, nestedSlice)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        // Interface aliases use the same reified element in opcode tokens
        // as in signatures, including source-defined and open elements.
        if element is SequenceTypeSymbol || element is AsyncSequenceTypeSymbol {
            let sigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), element)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        if element is ImportedTypeSymbol symbolicImported &&
            !symbolicImported
            .TypeArguments
            .IsDefaultOrEmpty &&
            !symbolicImported.HasTypeParameterArgument &&
            symbolicImported
            .TypeArguments
            .Any(TypeSymbol.RequiresSymbolicProjection) {
            let sigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), symbolicImported)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        // Issue #813: a tuple whose element types include an open generic
        // (TupleTypeSymbol.ClrType == null) needs a symbolic TypeSpec
        // built via the shared helper; the encoder threads each element
        // through EncodeTypeSymbol so the active iterator-state-machine
        // remap (issue #810) translates outer-method TPs to the SM
        // class's own type parameters. Without this branch, boxing a
        // `(int32, T)` to `object` from inside a state-machine method
        // body throws GS9998 from the EnumSymbol/throw tail below.
        if element is TupleTypeSymbol symbolicTuple && symbolicTuple.ClrType == nil && symbolicTuple.Arity >= 2 {
            return this.GetTupleTypeSpec(symbolicTuple)
        }
        // ADR-0087 §3 R3: an ImportedTypeSymbol whose generic args mention a
        // type parameter (e.g. `Dictionary<string, T>` where T is MVAR(0))
        // must tokenise as a TypeSpec carrying VAR/MVAR, not the erased
        // closed `ClrType` (which encodes T as `object`). Otherwise tokens
        // like `unbox.any Dictionary<string,T>` widen to the wrong shape.
        if element is ImportedTypeSymbol tpImported && tpImported.HasTypeParameterArgument {
            let sigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), tpImported)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        if element is FunctionTypeSymbol fnElement &&
            (fnElement.ClrType == nil || TypeSymbol.RequiresSymbolicProjection(fnElement)) {
            // ADR-0087 §3 R6: an open-bearing function type
            // (e.g. `(T) -> U`) tokenises as a TypeSpec for the
            // reified `Func<...>` / `Action<...>` shape, with VAR/MVAR
            // slots that the runtime substitutes against the
            // surrounding generic instantiation. Nullable slots inside a
            // constructed return type must also avoid its erased CLR backing.
            return this.GetFunctionDelegateTypeSpec(fnElement)
        }
        if element.ClrType != nil {
            // Issue #3501 (ilverify): element-bearing CLR shapes (arrays from
            // e.g. an imported `ParameterInfo[]` pattern binding) also route
            // through the TypeSpec path — see GetTypeHandleForMember.
            if element.ClrType.IsConstructedGenericType || element.ClrType.HasElementType {
                return this.GetTypeHandleForMember(element.ClrType)
            }
            return this.GetTypeReference(element.ClrType!!)
        }
        if element is StructSymbol structSym {
            // ADR-0087 §3 R3: a constructed user-generic struct must
            // tokenise as a TypeSpec, not the bare TypeDef row.
            if ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym) {
                return this.outer.userTokens.GetUserStructTypeSpec(structSym)
            }
            if this.cache.StructTypeDefs.TryGetValue(structSym, out var td) {
                return td
            }
        }
        if element is TypeParameterSymbol tpSym {
            // ADR-0087 §3 R3: a type-parameter element token (e.g. for
            // `stobj T` against a `&T` parameter, or `initobj T` for a
            // default value) encodes as a TypeSpec naming VAR(idx) /
            // MVAR(idx).
            let sigBlob = BlobBuilder()
            let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
            // Issue #810: inside an iterator state-machine member,
            // source TPs are remapped to the SM class's own TPs.
            if this
                .remaps
                .ActiveIteratorStateMachineRemap != nil &&
                this
                .remaps
                .ActiveIteratorStateMachineRemap!!.TryGetValue(tpSym, out var smClassOrd) {
                encoder.GenericTypeParameter(smClassOrd)
            } else if this
                .remaps
                .ActiveLambdaMethodTypeParamRemap != nil &&
                this
                .remaps
                .ActiveLambdaMethodTypeParamRemap!!
                .TryGetValue(tpSym, out var lambdaMethodOrd) {
                // Issue #2118: reference to an enclosing type parameter inside a
                // generic-promoted non-capturing lambda's signature/body maps to
                // the lambda method's own MVar(idx) slot.
                encoder.GenericMethodTypeParameter(lambdaMethodOrd)
            } else if this
                .remaps
                .ActiveIteratorStateMachineRemap != nil &&
                this
                .remaps
                .ActiveIteratorStateMachineRemap!!
                .TryGetValue(tpSym, out var smClassOrd2) {
                // Issue #1477: synthesized closure, capture-box, and nested-type
                // remaps still map class type parameters to their own VAR slots.
                encoder.GenericTypeParameter(smClassOrd2)
            } else if tpSym.IsMethodTypeParameter {
                encoder.GenericMethodTypeParameter(tpSym.Ordinal)
            } else {
                encoder.GenericTypeParameter(tpSym.Ordinal)
            }
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        }
        if element is EnumSymbol enumSym {
            let def = enumSym.Definition ?? enumSym
            if ReflectionMetadataEmitter.IsUserGenericEnumReference(enumSym) {
                return this.outer.userTokens.GetUserEnumTypeSpec(enumSym)
            }
            if this.cache.EnumTypeDefs.TryGetValue(def, out var etd) {
                return etd
            }
        }
        // Issue #1052: a user-declared interface used as a generic-parameter
        // constraint tokenises to its emitted TypeDef (non-generic) or a
        // TypeSpec naming the constructed instantiation (generic, e.g. the
        // self-referential `[T IFace[T]]`). This feeds the
        // GenericParamConstraint metadata row so the assembly verifies.
        if element is InterfaceSymbol ifaceSym {
            if ReflectionMetadataEmitter.IsUserGenericInterfaceReference(ifaceSym) {
                let sigBlob = BlobBuilder()
                this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), ifaceSym)
                return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
            }
            let ifaceDef = ifaceSym.Definition ?? ifaceSym
            if this.cache.InterfaceTypeDefs.TryGetValue(ifaceDef, out var itd) {
                return itd
            }
        }
        // Issue #3524: a user-declared named delegate used as a variadic
        // parameter's element type (e.g. `specs ... Spec`) needs the same
        // TypeDef/TypeSpec resolution as any other element-bearing symbolic
        // shape. Mirrors the StructSymbol/EnumSymbol/InterfaceSymbol branches
        // above.
        if element is DelegateTypeSymbol delegateSym {
            if ReflectionMetadataEmitter.IsUserGenericDelegateReference(delegateSym) {
                return this.outer.userTokens.GetUserDelegateTypeSpec(delegateSym)
            }
            let delegateDef = delegateSym.Definition ?? delegateSym
            if this.cache.DelegateTypeDefs.TryGetValue(delegateDef, out var dtd) {
                return dtd
            }
        }
        // ADR-0174 D2/D9: a channel type as an array element — `[]in chan[T]`,
        // the packed form of `merge`'s variadic. Its CLR shape is
        // `Channel`1`/`ChannelReader`1`/`ChannelWriter`1` over an element that
        // may itself be an open type parameter, so it encodes as a TypeSpec
        // rather than resolving to a TypeDef or a closed TypeRef.
        if element is ChannelTypeSymbol {
            let channelSigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(channelSigBlob).TypeSpecificationSignature(), element)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(channelSigBlob))
        }
        throw NotSupportedException("Cannot resolve element type token for '${element.Name}'.")
    }

    internal func GetTypeOfToken(type TypeSymbol) EntityHandle {
        // Issue #143: `typeof(T)` token resolution. `NullableTypeSymbol` over a
        // value type must surface as `System.Nullable<T>` to match C# semantics
        // (binder/evaluator collapse the wrapper to its underlying type for
        // every other purpose — ADR-0001).
        if type is NullableTypeSymbol nullable && nullable.UnderlyingType.ClrType is {IsValueType: true} valueClr {
            // Issue #571: see GetElementTypeToken for rationale.
            if !NullableLifting.TryConstructNullable(this.emitCtx.References, valueClr, out var nullableType) {
                throw InvalidOperationException(
                    "Cannot construct Nullable<${valueClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
                )
            }
            return this.GetTypeHandleForMember(nullableType)
        }
        // Issue #3678: `typeof(Slot)` / `typeof(Slot[_])` names the OPEN
        // generic DEFINITION of a type declared in this compilation, and
        // `ldtoken` of a definition takes its TypeDef row. The generic-
        // reference TypeSpec `GetElementTypeToken` builds instead
        // (`Slot<!0>`) names VAR slots that have no binding in this scope, so
        // the emitted PE failed to load with BadImageFormatException the
        // moment the `typeof` ran.
        if TryGetOpenGenericDefinition(type, out var definition) && this.TryGetUserTypeDef(
            definition!!,
            out var definitionHandle
        ) {
            return definitionHandle
        }
        return this.GetExactTypeToken(type)
    }

    /// Issue #3678: the emitted TypeDef row for a user-declared type.
    /// @param definition The type definition symbol.
    /// @param handle The TypeDef handle on success.
    /// @returns Whether a TypeDef row has been emitted for the definition.
    private func TryGetUserTypeDef(definition TypeSymbol, out handle EntityHandle) bool {
        switch definition {
            case structSym is StructSymbol when this.cache.StructTypeDefs.TryGetValue(structSym, out var structHandle) {
                handle = structHandle
                return true
            }
            case interfaceSym is InterfaceSymbol when this
                .cache
                .InterfaceTypeDefs
                .TryGetValue(interfaceSym, out var interfaceHandle) {
                handle = interfaceHandle
                return true
            }
            case delegateSym is DelegateTypeSymbol when this
                .cache
                .DelegateTypeDefs
                .TryGetValue(delegateSym.Definition ?? delegateSym, out var delegateHandle) {
                handle = delegateHandle
                return true
            }
            default {
                handle = default(EntityHandle)
                return false
            }
        }
    }

    private func GetAssemblyReference(assembly Assembly) AssemblyReferenceHandle {
        if this.cache.AssemblyRefs.TryGetValue(assembly, out var existing) {
            return existing
        }
        let name = assembly.GetName()
        let publicKeyToken = name.GetPublicKeyToken()
        let publicKeyOrTokenBlob = if publicKeyToken != nil && publicKeyToken.Length > 0 {
            this.emitCtx.Metadata.GetOrAddBlob(publicKeyToken)
        } else {
            default(BlobHandle)
        }
        let handle = this
            .emitCtx
            .Metadata
            .AddAssemblyReference(
            name: this.emitCtx.Metadata.GetOrAddString(name.Name ?? string.Empty),
            version: name.Version ?? Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle)
        )
        this.cache.AssemblyRefs[assembly] = handle
        return handle
    }

    /// Issue #242: Returns an AssemblyReferenceHandle for `System.Runtime`,
    /// the public facade assembly that external consumers (C#/F# projects)
    /// reference. Used as the resolution scope for base-type TypeRefs
    /// (System.Object, System.ValueType, System.Enum) so that compiled
    /// libraries are consumable without requiring a direct reference to
    /// `System.Private.CoreLib`.
    private func GetSystemRuntimeAssemblyReference() AssemblyReferenceHandle {
        if !this.cache.SystemRuntimeAssemblyRef.IsNil {
            return this.cache.SystemRuntimeAssemblyRef
        }
        var sysRuntimeName AssemblyName
        try {
            sysRuntimeName = Assembly.Load("System.Runtime").GetName()
        } catch {
            // Fallback: construct the identity using the well-known .NET
            // public key token (b03f5f7f11d50a3a) and the host CoreLib version.
            sysRuntimeName = AssemblyName("System.Runtime"){
                Version = typeof(object).Assembly.GetName().Version ?? Version(0, 0, 0, 0)
            }
            sysRuntimeName.SetPublicKeyToken(
                []uint8{
                    uint8(0xb0),
                    uint8(0x3f),
                    uint8(0x5f),
                    uint8(0x7f),
                    uint8(0x11),
                    uint8(0xd5),
                    uint8(0x0a),
                    uint8(0x3a)
                }
            )
        }
        let publicKeyToken = sysRuntimeName.GetPublicKeyToken()
        let publicKeyOrTokenBlob = if publicKeyToken != nil && publicKeyToken.Length > 0 {
            this.emitCtx.Metadata.GetOrAddBlob(publicKeyToken)
        } else {
            default(BlobHandle)
        }
        this
            .cache
            .SystemRuntimeAssemblyRef = this
            .emitCtx
            .Metadata
            .AddAssemblyReference(
            name: this.emitCtx.Metadata.GetOrAddString(sysRuntimeName.Name ?? "System.Runtime"),
            version: sysRuntimeName.Version ?? Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle)
        )
        return this.cache.SystemRuntimeAssemblyRef
    }

    internal func GetTypeReference(type Type) TypeReferenceHandle {
        if this.cache.TypeRefs.TryGetValue(type, out var existing) {
            return existing
        }
        // Issue #3718: a lowering or emit site that names a well-known BCL type
        // with a host `typeof(...)` hands us a *runtime* Type whose assembly is
        // whichever corlib happens to be hosting gsc (System.Private.CoreLib).
        // Scoping the TypeRef to that assembly leaks an implementation-assembly
        // AssemblyRef into a compilation whose reference closure only ever named
        // the targeting pack. Project the type onto the compilation's own
        // reference set first so the row is scoped to the contract assembly that
        // actually declares it. The host type remains the fallback for the
        // in-process/TPA path, where the resolver has no MetadataLoadContext and
        // the host identity is already the right one.
        if TryProjectOntoReferences(this.emitCtx.References, type, out var projected) {
            let projectedHandle = this.GetTypeReference(projected)
            this.cache.TypeRefs[type] = projectedHandle
            return projectedHandle
        }
        // Nested types: resolution scope is the TypeRef of the declaring type,
        // namespace is empty, name is the short name only. Works for the
        // open generic definition of a nested generic type as well (Reflection
        // treats Dictionary`2+Enumerator as nested under Dictionary`2).
        var resolutionScope EntityHandle
        var namespace StringHandle
        if type.IsNested && type.DeclaringType is Type declaring {
            resolutionScope = this.GetTypeReference(declaring)
            namespace = default(StringHandle)
        } else if IsCoreLibBaseType(type) {
            // Issue #242: base types (Object, ValueType, Enum, Attribute)
            // must reference System.Runtime — the public facade — so that
            // consuming C#/F# projects can resolve them. Other types in
            // System.Private.CoreLib (e.g. Dictionary<,>) keep pointing at
            // CoreLib because the runtime resolves them directly and they
            // may not have type-forwarders in System.Runtime.
            resolutionScope = this.GetSystemRuntimeAssemblyReference()
            namespace = this.emitCtx.Metadata.GetOrAddString(type.Namespace ?? string.Empty)
        } else {
            resolutionScope = this.GetAssemblyReference(type.Assembly)
            namespace = this.emitCtx.Metadata.GetOrAddString(type.Namespace ?? string.Empty)
        }
        let handle = this
            .emitCtx
            .Metadata
            .AddTypeReference(
            resolutionScope: resolutionScope,
            namespace: namespace,
            name: this.emitCtx.Metadata.GetOrAddString(type.Name)
        )
        this.cache.TypeRefs[type] = handle
        return handle
    }

    /// Returns a metadata handle suitable for use as the parent of a MemberRef.
    /// Returns a TypeRef for non-generic types and a TypeSpec encoding a
    /// `GenericInstantiation` for constructed generic types
    /// (e.g. `List<int>`, `Dictionary<string, int>`).
    internal func GetTypeHandleForMember(type Type) EntityHandle {
        // Issue #3501 (ilverify): an array (or any element-bearing shape —
        // byref, pointer) has no TypeRef row; a name-based reference emits a
        // bogus TypeRef literally called "ParameterInfo[]" that fails to
        // load. Route through a TypeSpec like constructed generics.
        if type.IsConstructedGenericType || type.HasElementType {
            if this.cache.TypeSpecs.TryGetValue(type, out var existingSpec) {
                return existingSpec
            }
            let sigBlob = BlobBuilder()
            let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
            this.signatures.EncodeClrType(encoder, type)
            let spec = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
            this.cache.TypeSpecs[type] = spec
            return spec
        }
        return this.GetTypeReference(type)
    }

    internal func GetMethodReference(method MethodInfo) MemberReferenceHandle {
        var method = method
        method = ResolveTypeBuilderConstructedGenericMethod(method)!!
        if this.cache.MethodRefs.TryGetValue(method, out var existing) {
            return existing
        }
        let declaring = method.DeclaringType ??
            throw InvalidOperationException("Imported method has no declaring type.")
        let parent = this.GetTypeHandleForMember(declaring)
        // For instance methods on constructed generic types, encode the signature
        // from the OPEN definition so parameters/returns reference declaring-type
        // generic params by position (!0, !1, ...). For non-generic declarings,
        // open == closed and parameter types are concrete.
        let openMethod = GetOpenMethod(method)
        // When the method itself is generic (e.g. Channel.CreateUnbounded<T>),
        // encode the MemberRef against its generic definition so `!!N` placeholders
        // referenced in the signature resolve correctly. The caller wraps the
        // resulting handle in a MethodSpecification.
        let openForMethodGenerics = if openMethod!!.IsGenericMethod {
            openMethod!!.GetGenericMethodDefinition()
        } else {
            openMethod!!
        }
        let sigBlob = BlobBuilder()
        let sigEncoder = BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: !method.IsStatic,
            genericParameterCount: if openForMethodGenerics.IsGenericMethodDefinition {
                openForMethodGenerics.GetGenericArguments().Length
            } else {
                0
            }
        )
        sigEncoder.Parameters(
            openForMethodGenerics.GetParameters().Length,
            returnType: (r ReturnTypeEncoder) -> this.signatures.EncodeReturnClr(
                r,
                openForMethodGenerics.ReturnParameter,
                openForMethodGenerics.ReturnType
            ),
            parameters: (ps ParametersEncoder) -> {
                for p in openForMethodGenerics.GetParameters() {
                    this.signatures.EncodeParameterClr(ps.AddParameter(), p)
                }
            }
        )
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.MethodRefs[method] = handle
        return handle
    }

    // Phase E: returns a callable EntityHandle for any MethodInfo, wrapping
    // constructed generic methods in a MethodSpecification per ECMA-335 II.23.2.15.
    internal func GetMethodEntityHandle(method MethodInfo) EntityHandle {
        return this.GetMethodEntityHandle(method, default(ImmutableArray[TypeSymbol?]))
    }

    internal func GetMethodEntityHandle(method MethodInfo, containingTypeSymbol TypeSymbol?) EntityHandle {
        return this.GetMethodEntityHandle(method, default(ImmutableArray[TypeSymbol?]), containingTypeSymbol)
    }

    // Issue #320: callable EntityHandle for a constructed generic method whose
    // explicit type arguments may include user-defined types. User-defined type
    // arguments have no reference-context CLR type, so the method was closed with
    // a System.Object placeholder; the real type-argument symbols are encoded into
    // the method specification here (as their own TypeDef tokens) instead of the
    // placeholder. When typeArgSymbols is default the placeholder CLR arguments are
    // encoded, preserving the BCL-only behavior.
    internal func GetMethodEntityHandle(method MethodInfo, typeArgSymbols ImmutableArray[TypeSymbol?]) EntityHandle {
        return this.GetMethodEntityHandle(method, typeArgSymbols, nil)
    }

    internal func GetMethodEntityHandle(
        method MethodInfo,
        typeArgSymbols ImmutableArray[TypeSymbol?],
        containingTypeSymbol TypeSymbol?
    ) EntityHandle {
        if TryCreateMemberReferenceForConstructedSymbolicContainer(method, containingTypeSymbol, out var symbolicRef) {
            if !method.IsGenericMethod || method.IsGenericMethodDefinition {
                return symbolicRef
            }
            let symbolicClosedArgs = method.GetGenericArguments()
            let symbolicSigBlob = BlobBuilder()
            let symbolicArgsEncoder = BlobEncoder(symbolicSigBlob).MethodSpecificationSignature(
                symbolicClosedArgs.Length
            )
            for var i = 0; i < symbolicClosedArgs.Length; i++ {
                if !typeArgSymbols.IsDefaultOrEmpty &&
                    i < typeArgSymbols.Length &&
                    typeArgSymbols[i] is {} symbolicTypeArgument &&
                    TypeSymbol
                    .RequiresSymbolicProjection(symbolicTypeArgument) {
                    this.signatures.EncodeTypeSymbol(symbolicArgsEncoder.AddArgument(), symbolicTypeArgument)
                } else {
                    this.signatures.EncodeClrType(symbolicArgsEncoder.AddArgument(), symbolicClosedArgs[i])
                }
            }
            return this
                .emitCtx
                .MetadataRows
                .AddMethodSpecification(symbolicRef, this.emitCtx.Metadata.GetOrAddBlob(symbolicSigBlob))
        }
        if !method.IsGenericMethod || method.IsGenericMethodDefinition {
            return this.GetMethodReference(method)
        }
        // The placeholder-closed MethodInfo is identical across distinct
        // user-type arguments (all close to <object>), so the cache must be keyed
        // by the symbol arguments too. Issue #420 (P3-7): previously this case
        // bypassed the cache entirely, producing duplicate MethodSpec rows when
        // the same generic method was referenced multiple times with the same
        // user-type generic args.
        let hasSymbolArgs = !typeArgSymbols.IsDefaultOrEmpty && typeArgSymbols.Any(
            (symbol TypeSymbol?) -> symbol != nil && TypeSymbol.RequiresSymbolicProjection(symbol)
        )
        if !hasSymbolArgs {
            if this.cache.MethodSpecs.TryGetValue(method, out var existing) {
                return existing
            }
        } else {
            let symbolKey = MetadataTokenCache.MethodSpecSymbolKey(method, typeArgSymbols, this.remaps.CurrentScope)
            if this.cache.MethodSpecsWithSymbolArgs.TryGetValue(symbolKey, out var existingSym) {
                return existingSym
            }
        }
        let openDef = method.GetGenericMethodDefinition()
        let openRef = this.GetMethodReference(openDef)
        let closedArgs = method.GetGenericArguments()
        let sigBlob = BlobBuilder()
        let argsEncoder = BlobEncoder(sigBlob).MethodSpecificationSignature(closedArgs.Length)
        for var i = 0; i < closedArgs.Length; i++ {
            // Issue #320: encode a user-defined type argument via its symbol so it
            // resolves to the emitted TypeDef; BCL arguments use the closed CLR type.
            // Issue #671: also recurse through nested constructed generics so a
            // `MyGeneric<List<MyGs>>` argument is encoded symbolically rather than
            // collapsing to System.Object at the placeholder.
            if !typeArgSymbols.IsDefaultOrEmpty &&
                i < typeArgSymbols.Length &&
                typeArgSymbols[i] is {} symbolicTypeArgument &&
                TypeSymbol
                .RequiresSymbolicProjection(symbolicTypeArgument) {
                this.signatures.EncodeTypeSymbol(argsEncoder.AddArgument(), symbolicTypeArgument)
            } else {
                this.signatures.EncodeClrType(argsEncoder.AddArgument(), closedArgs[i])
            }
        }
        let spec = this
            .emitCtx
            .MetadataRows
            .AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        if !hasSymbolArgs {
            this.cache.MethodSpecs[method] = spec
        } else {
            this
                .cache
                .MethodSpecsWithSymbolArgs[
                MetadataTokenCache.MethodSpecSymbolKey(method, typeArgSymbols, this.remaps.CurrentScope)
            ] = spec
        }
        return spec
    }

    private func TryCreateMemberReferenceForConstructedSymbolicContainer(
        method MethodInfo?,
        containingTypeSymbol TypeSymbol?,
        out handle MemberReferenceHandle
    ) bool {
        handle = default(MemberReferenceHandle)
        if method == nil ||
            !TryNormalizeToSymbolicContainer(containingTypeSymbol, out var openDefinition, out var typeArguments) ||
            typeArguments.IsDefaultOrEmpty {
            return false
        }
        // Issue #774: when the method is declared on a non-generic base
        // (e.g. `IEnumerator.MoveNext()` inherited via `IEnumerator<T>`, or
        // `IDisposable.Dispose()` on the same enumerator), encoding a
        // symbolic generic parent TypeSpec produces a verifier-rejected
        // MemberRef (`MoveNext` is not declared on `IEnumerator<>`). Let the
        // plain MemberRef path encode the parent as the actual non-generic
        // declaring type by short-circuiting here.
        let methodDecl Type? = method.DeclaringType
        if methodDecl != nil && !methodDecl.IsGenericType && methodDecl != openDefinition {
            return false
        }
        // Issue #774: when the method is declared on a generic interface or
        // base type that the receiver's openDefinition implements (e.g.
        // `IEnumerable<object>.GetEnumerator()` called on a
        // `Dictionary[K, V]`), the parent TypeSpec must be the substituted
        // interface — not the receiver's own openDefinition. Otherwise
        // ResolveMethodOnOpenDefinition would pick the receiver's hiding
        // method (e.g. Dictionary's struct-returning GetEnumerator) and the
        // verifier would see a struct value where an interface reference is
        // expected.
        if methodDecl != nil && methodDecl.IsGenericType && openDefinition != nil {
            let methodDeclOpen = if methodDecl.IsGenericTypeDefinition {
                methodDecl
            } else {
                methodDecl.GetGenericTypeDefinition()
            }
            if !SameOpenTypeDefinition(methodDeclOpen, openDefinition) {
                if TryFindImplementedInterfaceInstantiation(
                    openDefinition,
                    methodDeclOpen,
                    out var ifaceInstantiation
                ) {
                    let ifaceArgs = ifaceInstantiation.GetGenericArguments()
                    let symbolicIfaceArgs = ImmutableArray.CreateBuilder[TypeSymbol](ifaceArgs.Length)
                    for ifa in ifaceArgs {
                        symbolicIfaceArgs.Add(
                            MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                                ifa,
                                openDefinition,
                                typeArguments,
                                NullabilityFreeReason.TypeStructure
                            )
                        )
                    }
                    openDefinition = methodDeclOpen
                    typeArguments = symbolicIfaceArgs.MoveToImmutable()
                }
            }
        }
        // Synthesize an ImportedTypeSymbol view of the receiver so the
        // parent TypeSpec encoder retains its constructed arguments uniformly
        // — regardless of whether the actual
        // receiver was an ImportedTypeSymbol, a SequenceTypeSymbol with
        // null ClrType (issue #774), or an AsyncSequenceTypeSymbol with
        // null ClrType.
        let openContainer = Invariant.Required(
            openDefinition,
            "TryNormalizeToSymbolicContainer only reports success with an open definition, and the interface re-targeting above keeps one",
            expression: "openDefinition"
        )
        let symbolicView = ImportedTypeSymbol.GetConstructed(
            openContainer.MakeGenericType(this.GetErasedObjectArgs(openContainer)),
            openContainer,
            typeArguments
        )
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), symbolicView)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let openMethod = Invariant.Required(
            ResolveMethodOnOpenDefinition(openContainer, method),
            "the symbolic container was normalized from this method's own declaring type, so its open definition declares the method",
            expression: "ResolveMethodOnOpenDefinition(openContainer, method)"
        )
        let openForMethodGenerics = if openMethod.IsGenericMethod {
            openMethod.GetGenericMethodDefinition()
        } else {
            openMethod
        }
        let sigBlob = BlobBuilder()
        let sigEncoder = BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: !method.IsStatic,
            genericParameterCount: if openForMethodGenerics.IsGenericMethodDefinition {
                openForMethodGenerics.GetGenericArguments().Length
            } else {
                0
            }
        )
        sigEncoder.Parameters(
            openForMethodGenerics.GetParameters().Length,
            returnType: (r ReturnTypeEncoder) -> this.signatures.EncodeReturnClr(
                r,
                openForMethodGenerics.ReturnParameter,
                openForMethodGenerics.ReturnType
            ),
            parameters: (ps ParametersEncoder) -> {
                for p in openForMethodGenerics.GetParameters() {
                    this.signatures.EncodeParameterClr(ps.AddParameter(), p)
                }
            }
        )
        handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return true
    }

    // Issue #821: choose the right erased `object` for an open generic
    // definition's MakeGenericType call. The open def may live in a
    // MetadataLoadContext (reference-pack assemblies); passing a live
    // `typeof(object)` to its MakeGenericType raises ArgumentException with
    // "type was not loaded by the MetadataLoadContext that loaded the
    // generic type or method." Use `emitCtx.CoreObjectType`, which is the
    // System.Object resolved through the active reference context, when the
    // open def lives outside the host runtime.
    private func GetErasedObjectArgs(openDefinition Type)[]Type {
        let parameters = openDefinition.GetGenericArguments()
        let result = [parameters.Length]Type
        let coreObject = ChooseErasedObjectType(openDefinition)
        for var i = 0; i < parameters.Length; i++ {
            // Issue #806: a generic parameter with the `struct`
            // constraint cannot be closed with `System.Object`
            // (MakeGenericType throws ArgumentException). Use a
            // BCL value-type placeholder (`int32`) so the
            // symbolic-container path can construct the closed
            // type purely for parent-TypeSpec encoding. The
            // closed type's identity is irrelevant beyond the
            // open definition's reflection metadata.
            let p = parameters[i]
            if (p.GenericParameterAttributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 {
                result[i] = ChooseErasedValueTypeType(openDefinition)
            } else {
                result[i] = coreObject
            }
        }
        return result
    }

    private func ChooseErasedValueTypeType(openDefinition Type) Type {
        let hostInt = typeof(int32)
        if openDefinition?.Assembly == hostInt.Assembly {
            return hostInt
        }
        return this.emitCtx.CoreInt32Type ?? hostInt
    }

    private func ChooseErasedObjectType(openDefinition Type) Type {
        // Same context as the open def → cheap path.
        let hostObject = typeof(object)
        if openDefinition?.Assembly == hostObject.Assembly {
            return hostObject
        }
        return this.emitCtx.CoreObjectType
    }

    /// Phase 4 emit parity: get a MemberRef for a CLR instance constructor.
    /// Handles both non-generic types (`StringBuilder()`) and constructed
    /// generic types (`List<int>()`, `Dictionary<string, int>()`).
    internal func GetCtorReference(ctor ConstructorInfo) MemberReferenceHandle -> this.GetCtorReference(
        ctor,
        containingTypeSymbol: nil
    )

    /// Phase 4 emit parity: get a MemberRef for a CLR instance constructor on a
    /// possibly type-erased generic declaring type. When
    /// [`containingTypeSymbol`](paramref) is an
    /// (cref:ImportedTypeSymbol) whose (cref:ImportedTypeSymbol.TypeArguments)
    /// require symbolic projection (including nullable delegate shapes), the parent
    /// TypeSpec is encoded against those symbolic arguments (resolving to the
    /// real user-defined TypeDef tokens) instead of the type-erased
    /// `Open<object,…>` shape carried by [`ctor`](paramref).
    /// @param ctor The (possibly type-erased) constructor selected by overload resolution.
    /// @param containingTypeSymbol The bound result type of the construction expression. May be `null`.
    /// @returns A MemberRef handle for the constructor on the correctly-typed parent.
    internal func GetCtorReference(ctor ConstructorInfo, containingTypeSymbol TypeSymbol?) MemberReferenceHandle {
        var ctor = ctor
        ctor = ResolveTypeBuilderConstructedGenericCtor(ctor)!!
        // Issue #671: when the containing type carries symbolic user-type
        // arguments, the cache key needs to discriminate per symbol set
        // (multiple distinct user-type closures share a single type-erased
        // ConstructorInfo).
        if TryCreateCtorMemberReferenceForConstructedSymbolicContainer(
            ctor,
            containingTypeSymbol,
            out var symbolicHandle
        ) {
            return symbolicHandle
        }
        if this.cache.CtorRefs.TryGetValue(ctor, out var existing) {
            return existing
        }
        let declaring = ctor.DeclaringType ??
            throw InvalidOperationException("Imported constructor has no declaring type.")
        let parent = this.GetTypeHandleForMember(declaring)
        let openCtor = GetOpenCtor(ctor)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            openCtor!!.GetParameters().Length,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                for p in openCtor!!.GetParameters() {
                    this.signatures.EncodeParameterClr(ps.AddParameter(), p)
                }
            }
        )
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.CtorRefs[ctor] = handle
        return handle
    }

    /// Issue #671: builds a constructor MemberRef whose parent TypeSpec is
    /// encoded from the original symbolic type arguments, including reified
    /// nullable delegates, rather than the type-erased
    /// `Open<object,…>` shape baked into the constructor's
    /// (cref:MemberInfo.DeclaringType). Mirrors the method
    /// counterpart in (cref:TryCreateMemberReferenceForConstructedSymbolicContainer).
    /// @param ctor The (type-erased) constructor.
    /// @param containingTypeSymbol The bound type of the call's result; expected to be an
    /// (cref:ImportedTypeSymbol) carrying arguments requiring symbolic projection.
    /// @param handle On success, the new MemberRef handle.
    /// @returns Whether a symbolic-container MemberRef was produced.
    private func TryCreateCtorMemberReferenceForConstructedSymbolicContainer(
        ctor ConstructorInfo?,
        containingTypeSymbol TypeSymbol?,
        out handle MemberReferenceHandle
    ) bool {
        handle = default(MemberReferenceHandle)
        if ctor == nil ||
            containingTypeSymbol is not ImportedTypeSymbol imported ||
            imported.OpenDefinition == nil ||
            imported
            .TypeArguments
            .IsDefaultOrEmpty ||
            !imported
            .TypeArguments
            .Any(TypeSymbol.RequiresSymbolicProjection) {
            return false
        }
        let cacheKey = MetadataTokenCache.CtorRefSymbolKey(ctor, imported.TypeArguments, this.remaps.CurrentScope)
        if this.cache.CtorRefsWithSymbolArgs.TryGetValue(cacheKey, out var cached) {
            handle = cached
            return true
        }
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), imported)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let openCtor = ResolveCtorOnOpenDefinition(imported.OpenDefinition, ctor)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            openCtor.GetParameters().Length,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                for p in openCtor.GetParameters() {
                    this.signatures.EncodeParameterClr(ps.AddParameter(), p)
                }
            }
        )
        handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.CtorRefsWithSymbolArgs[cacheKey] = handle
        return true
    }

    /// Issue #814 / ADR-0084 §L5: builds a `MemberRef` parented at the
    /// `TypeSpec` for `System.Nullable`1<!!T>` with signature
    /// `instance void .ctor(!0)`. The CLR substitutes `!0` against
    /// the parent's first generic argument at call time, so a single
    /// MemberRef serves every instantiation. Used by the
    /// `T → Nullable<T>` value-type lift when `T` is an open
    /// type parameter constrained to `struct` — the closed
    /// (cref:ConstructorInfo) we normally route through
    /// (cref:GetCtorReference(ConstructorInfo)) is unavailable because
    /// (cref:TypeParameterSymbol) has no (cref:Type).
    /// @param nullableOfTp A (cref:NullableTypeSymbol) whose underlying type is an open
    /// (cref:TypeParameterSymbol).
    /// @returns The MemberRef handle for `Nullable<!!T>::.ctor(!0)`.
    internal func GetNullableCtorMemberRefForOpenTypeParameter(nullableOfTp NullableTypeSymbol) MemberReferenceHandle {
        if nullableOfTp?.UnderlyingType is not TypeParameterSymbol tp {
            throw InvalidOperationException(
                "GetNullableCtorMemberRefForOpenTypeParameter requires Nullable<TypeParameter>."
            )
        }
        let tpKey = (tp, this.remaps.CurrentScope)
        if this.cache.NullableOpenCtorMemberRefs.TryGetValue(tpKey, out var cached) {
            return cached
        }
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfTp)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            parameterCount: 1,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                // `!0`: the parent TypeSpec's first generic parameter
                // (i.e. the inner type that Nullable<> is closed over).
                ps.AddParameter().Type().GenericTypeParameter(0)
            }
        )
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.NullableOpenCtorMemberRefs[tpKey] = handle
        return handle
    }

    /// Issue #1298: gets a MemberRef for `System.Nullable`1<E>::.ctor(!0)`
    /// where `E` is a user-declared enum emitted in this assembly. The
    /// enum has no runtime CLR type, so the BCL-backed
    /// (cref:WellKnownReferences) ctor path cannot construct it; instead
    /// the parent TypeSpec closes `Nullable<>` over the enum's TypeDef
    /// and the ctor signature refers to that argument as `!0`. Mirrors
    /// (cref:GetNullableCtorMemberRefForOpenTypeParameter).
    /// @param nullableOfEnum A `Nullable<E>` over a user enum.
    /// @returns The constructor MemberRef.
    internal func GetNullableCtorMemberRefForUserEnum(nullableOfEnum NullableTypeSymbol) MemberReferenceHandle {
        if nullableOfEnum?.UnderlyingType is not EnumSymbol enumSym {
            throw InvalidOperationException("GetNullableCtorMemberRefForUserEnum requires Nullable<EnumSymbol>.")
        }
        let enumKey = (enumSym, this.remaps.CurrentScope)
        if this.cache.NullableUserEnumCtorMemberRefs.TryGetValue(enumKey, out var cached) {
            return cached
        }
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfEnum)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            parameterCount: 1,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                ps.AddParameter().Type().GenericTypeParameter(0)
            }
        )
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.NullableUserEnumCtorMemberRefs[enumKey] = handle
        return handle
    }

    /// Issues #1475/#3088: gets a MemberRef for
    /// `System.Nullable`1<T>::.ctor(!0)` where `T` requires
    /// symbolic encoding. The parent TypeSpec closes `Nullable<>`
    /// over that encoded underlying and the ctor signature refers to it as
    /// `!0`.
    /// @param nullableOfUserVt A nullable over a symbolically encoded value type.
    /// @returns The constructor MemberRef.
    internal func GetNullableCtorMemberRefForUserValueType(nullableOfUserVt NullableTypeSymbol?) MemberReferenceHandle {
        // A user enum already has a dedicated cache + helper; reuse it so a
        // single MemberRef serves both the lift (issue #1298) and the
        // null-conditional (issue #1475) sites.
        if nullableOfUserVt?.UnderlyingType is EnumSymbol {
            return this.GetNullableCtorMemberRefForUserEnum(nullableOfUserVt!!)
        }
        if nullableOfUserVt == nil || !NullableLifting.RequiresSymbolicNullableGetValue(nullableOfUserVt) ||
            nullableOfUserVt.UnderlyingType is TypeParameterSymbol {
            throw InvalidOperationException(
                "GetNullableCtorMemberRefForUserValueType requires Nullable<symbolic value type>."
            )
        }
        let underlying = nullableOfUserVt.UnderlyingType
        let underlyingKey = (underlying, this.remaps.CurrentScope)
        if this.cache.NullableUserStructCtorMemberRefs.TryGetValue(underlyingKey, out var cached) {
            return cached
        }
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfUserVt)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            parameterCount: 1,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                ps.AddParameter().Type().GenericTypeParameter(0)
            }
        )
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.NullableUserStructCtorMemberRefs[underlyingKey] = handle
        return handle
    }

    /// Issue #1572 / #2333: gets a MemberRef for
    /// `System.Nullable`1<T>::get_Value()` where `T` is either a
    /// user-declared value type emitted in this assembly (a value-kind
    /// (cref:StructSymbol) or an (cref:EnumSymbol)) or an open
    /// type parameter constrained to `struct`. Neither shape has a
    /// resolvable runtime CLR (cref:Type) during emit, so the
    /// BCL-backed (cref:WellKnownReferences.GetNullableGetValueReference)
    /// path cannot build the MemberRef; instead the parent TypeSpec closes
    /// `Nullable<>` over the emitted TypeDef/TypeSpec (or the
    /// generic-parameter var/mvar signature slot) and the getter returns
    /// `!0`. Used by the `(v!!)` unwrap, value-type narrowing-read
    /// emit, and the null-conditional receiver probe.
    /// @param nullableOfUserVt A `Nullable<T>` over a user value type (enum or value struct) or a
    /// struct-constrained type parameter.
    /// @returns The `get_Value()` MemberRef.
    internal func GetNullableGetValueMemberRefForUserValueType(
        nullableOfUserVt NullableTypeSymbol?
    ) MemberReferenceHandle {
        if nullableOfUserVt == nil || !NullableLifting.RequiresSymbolicNullableGetValue(nullableOfUserVt) {
            throw InvalidOperationException(
                "GetNullableGetValueMemberRefForUserValueType requires Nullable<symbolic value type>."
            )
        }
        let underlying = nullableOfUserVt.UnderlyingType
        let underlyingKey = (underlying, this.remaps.CurrentScope)
        if this.cache.NullableUserValueTypeGetValueMemberRefs.TryGetValue(underlyingKey, out var cached) {
            return cached
        }
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfUserVt)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            parameterCount: 0,
            returnType: (r ReturnTypeEncoder) -> r.Type().GenericTypeParameter(0),
            parameters: (_ ParametersEncoder) -> { }
        )
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("get_Value"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.NullableUserValueTypeGetValueMemberRefs[underlyingKey] = handle
        return handle
    }

    /// Issue #2388: gets a MemberRef for
    /// `System.Nullable`1<T>::get_HasValue()` where `T` is a
    /// user-declared value type emitted in this assembly (a value-kind
    /// (cref:StructSymbol) or an (cref:EnumSymbol)). Mirrors
    /// (cref:GetNullableGetValueMemberRefForUserValueType) exactly,
    /// except the getter returns `bool` instead of `!0`. Needed to
    /// HasValue-branch a nullable-lifted Stream C/D custom-operator call
    /// (e.g. a same-compilation struct's `operator ==`) over
    /// `Nullable<UserStruct>` operands, where no real CLR
    /// (cref:System.Type) exists at emit time to resolve the
    /// reflection-based (cref:WellKnownReferences.GetNullableGetHasValueReference).
    /// @param nullableOfUserVt A `Nullable<T>` over a user value type (enum or value struct).
    /// @returns The `get_HasValue()` MemberRef.
    internal func GetNullableGetHasValueMemberRefForUserValueType(
        nullableOfUserVt NullableTypeSymbol?
    ) MemberReferenceHandle {
        if nullableOfUserVt == nil || !NullableLifting.RequiresSymbolicNullableGetValue(nullableOfUserVt) {
            throw InvalidOperationException(
                "GetNullableGetHasValueMemberRefForUserValueType requires Nullable<symbolic value type>."
            )
        }
        let underlying = nullableOfUserVt.UnderlyingType
        let underlyingKey = (underlying, this.remaps.CurrentScope)
        if this.cache.NullableUserValueTypeGetHasValueMemberRefs.TryGetValue(underlyingKey, out var cached) {
            return cached
        }
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfUserVt)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            parameterCount: 0,
            returnType: (r ReturnTypeEncoder) -> r.Type().Boolean(),
            parameters: (_ ParametersEncoder) -> { }
        )
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("get_HasValue"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.NullableUserValueTypeGetHasValueMemberRefs[underlyingKey] = handle
        return handle
    }

    /// Phase 4 emit parity: get a MemberRef for a CLR field on a possibly
    /// generic declaring type (e.g. `KeyValuePair<K, V>.Key`).
    internal func GetFieldReference(field FieldInfo) MemberReferenceHandle {
        var field = field
        field = ResolveTypeBuilderConstructedGenericField(field)!!
        if this.cache.FieldRefs.TryGetValue(field, out var existing) {
            return existing
        }
        let declaring = field.DeclaringType ?? throw InvalidOperationException("Imported field has no declaring type.")
        let parent = this.GetTypeHandleForMember(declaring)
        // Use the open field's FieldType so it encodes as !N when applicable.
        let openField = if declaring.IsConstructedGenericType {
            declaring.GetGenericTypeDefinition().GetField(
                field.Name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            ) ??
                field
        } else {
            field
        }
        let sigBlob = BlobBuilder()
        this.signatures.EncodeClrType(BlobEncoder(sigBlob).FieldSignature(), ClrNullability.GetSignatureType(openField))
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(field.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        this.cache.FieldRefs[field] = handle
        return handle
    }

    internal func GetFieldReference(field FieldInfo, containingTypeSymbol TypeSymbol) MemberReferenceHandle {
        if !TryNormalizeToSymbolicContainer(containingTypeSymbol, out var openDefinition, out var typeArguments) {
            return this.GetFieldReference(field)
        }
        let openField = openDefinition.GetField(
            field.Name,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
        ) ??
            throw InvalidOperationException(
            "Open generic type '${openDefinition.FullName}' has no field '${field.Name}'."
        )
        let symbolicView = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(this.GetErasedObjectArgs(openDefinition)),
            openDefinition,
            typeArguments
        )
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), symbolicView)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let sigBlob = BlobBuilder()
        this.signatures.EncodeClrType(BlobEncoder(sigBlob).FieldSignature(), ClrNullability.GetSignatureType(openField))
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent,
            this.emitCtx.Metadata.GetOrAddString(field.Name),
            this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// Issue #649: Gets a MemberRef for a field on a constructed generic type without
    /// calling `.GetField()` on the closed generic (which throws
    /// (cref:NotSupportedException) when type arguments are MLC-loaded or
    /// TypeBuilder-backed). Resolves the field from the open generic type definition.
    internal func GetFieldReferenceOnConstructedGeneric(
        closedGenericType Type,
        fieldName string
    ) MemberReferenceHandle {
        let openType = closedGenericType.GetGenericTypeDefinition()
        let openField = openType.GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
        ) ??
            throw InvalidOperationException("Open generic type '${openType.FullName}' has no field '$fieldName'.")
        let parent = this.GetTypeHandleForMember(closedGenericType)
        let sigBlob = BlobBuilder()
        this.signatures.EncodeClrType(BlobEncoder(sigBlob).FieldSignature(), ClrNullability.GetSignatureType(openField))
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(fieldName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return handle
    }

    /// Issue #649: Gets a MemberRef for a constructor on a constructed generic type without
    /// calling `.GetConstructors()` on the closed generic (which throws
    /// (cref:NotSupportedException) when type arguments are MLC-loaded or
    /// TypeBuilder-backed). Resolves the constructor from the open generic type definition.
    internal func GetCtorReferenceOnConstructedGeneric(closedGenericType Type, paramCount int32) MemberReferenceHandle {
        let openType = closedGenericType.GetGenericTypeDefinition()
        var openCtor ConstructorInfo? = nil
        for c in openType.GetConstructors() {
            if c.GetParameters().Length == paramCount {
                openCtor = c
                break
            }
        }
        if openCtor == nil {
            throw InvalidOperationException(
                "Open generic type '${openType.FullName}' has no constructor of arity $paramCount."
            )
        }
        let parent = this.GetTypeHandleForMember(closedGenericType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            openCtor.GetParameters().Length,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                for p in openCtor!!.GetParameters() {
                    this.signatures.EncodeParameterClr(ps.AddParameter(), p)
                }
            }
        )
        let handle = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return handle
    }

    /// Issue #1449: Gets a MemberRef for a delegate's canonical
    /// `(object, IntPtr)` constructor in a TypeBuilder-safe way.
    ///
    /// Calling (cref:Type.GetConstructors()) on a constructed generic
    /// delegate type (e.g. `Func<…>` / `Action<…>`) that
    /// is realized as a reflection-emit `TypeBuilderInstantiation` throws
    /// (cref:NotSupportedException) ("TypeBuilder generic instantiation
    /// does not support resolving members. Use TypeBuilder.GetConstructor
    /// instead."). This happens both when a type argument is a
    /// (cref:TypeBuilder) closed in the same compilation (#671) and when
    /// the instantiation is constructed against the in-progress assembly even
    /// though every type argument is a runtime type (#1449). In either case the
    /// MemberRef is built from the open generic definition's canonical ctor
    /// signature parented at the constructed-generic TypeSpec instead.
    /// @param delegateType The (possibly constructed-generic) delegate CLR type.
    /// @returns A MemberRef handle for the delegate's `(object, IntPtr)` constructor.
    internal func GetDelegateCtorReference(delegateType Type) MemberReferenceHandle {
        if delegateType.IsConstructedGenericType {
            var ctor ConstructorInfo
            try {
                ctor = delegateType.GetConstructors()[0]
            } catch (NotSupportedException) {
                // Reflection-emit limitation: GetConstructors() throws on a
                // generic delegate realized as a TypeBuilderInstantiation. Build
                // the MemberRef from the open definition's canonical
                // (object, IntPtr) delegate ctor parented at the TypeSpec.
                return this.GetCtorReferenceOnConstructedGeneric(delegateType, paramCount: 2)
            }
            return this.GetCtorReference(ctor)
        }
        return this.GetCtorReference(delegateType.GetConstructors()[0])
    }

    /// Issue #649: Gets the TypeSpec handle for a `ValueTuple<...>` whose element
    /// types include G#-defined types (StructSymbol) that lack a CLR backing type.
    /// Encodes each element type via (cref:SignatureEncoder.EncodeTypeSymbol) so user-defined types
    /// are correctly referenced by their TypeDef handles.
    private func GetTupleTypeSpec(tupleType TupleTypeSymbol) EntityHandle -> this.GetTupleTypeSpec(
        tupleType,
        0,
        tupleType.Arity
    )

    private func GetTupleTypeSpec(tupleType TupleTypeSymbol, start int32, count int32) EntityHandle {
        let sigBlob = BlobBuilder()
        this.signatures.EncodeTupleType(
            BlobEncoder(sigBlob).TypeSpecificationSignature(),
            tupleType.ElementTypes,
            start,
            count
        )
        return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// Issue #649: Gets a MemberRef for a tuple field when the tuple's
    /// (cref:TypeSymbol.ClrType) is null (element types include
    /// G#-defined types). Builds the field MemberRef against the appropriate
    /// symbolically-constructed `ValueTuple` node TypeSpec.
    internal func GetTupleFieldReference(
        tupleType TupleTypeSymbol,
        start int32,
        count int32,
        fieldName string
    ) MemberReferenceHandle {
        let parent = this.GetTupleTypeSpec(tupleType, start, count)
        // Get the open field from the BCL ValueTuple generic definition for signature encoding.
        let openType = TupleTypeSymbol.GetOpenClrType(
            if count <= 7 {
                count
            } else {
                8
            }
        )
        let openField = openType.GetField(fieldName, BindingFlags.Instance | BindingFlags.Public) ??
            throw InvalidOperationException("Open ValueTuple type has no field '$fieldName'.")
        let sigBlob = BlobBuilder()
        this.signatures.EncodeClrType(BlobEncoder(sigBlob).FieldSignature(), ClrNullability.GetSignatureType(openField))
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(fieldName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// Issue #649: Gets a MemberRef for a tuple constructor when the tuple's
    /// (cref:TypeSymbol.ClrType) is null (element types include G#-defined
    /// types). Builds the ctor MemberRef against the symbolically-constructed
    /// `ValueTuple` TypeSpec.
    internal func GetTupleCtorReference(tupleType TupleTypeSymbol, start int32, count int32) MemberReferenceHandle {
        let parent = this.GetTupleTypeSpec(tupleType, start, count)
        let physicalArity = if count <= 7 {
            count
        } else {
            8
        }
        let openType = TupleTypeSymbol.GetOpenClrType(physicalArity)
        var openCtor ConstructorInfo? = nil
        for c in openType.GetConstructors() {
            if c.GetParameters().Length == physicalArity {
                openCtor = c
                break
            }
        }
        if openCtor == nil {
            throw InvalidOperationException("Open ValueTuple type of arity $physicalArity has no matching constructor.")
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            openCtor.GetParameters().Length,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                for p in openCtor!!.GetParameters() {
                    this.signatures.EncodeParameterClr(ps.AddParameter(), p)
                }
            }
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// Issue #1481: builds a `TypeSpec` encoding
    /// `System.Collections.Generic.Dictionary`2<K, V>` with the key
    /// and value routed through (cref:SignatureEncoder.EncodeTypeSymbol), so an in-scope
    /// type parameter survives as a `Var`/`MVar` slot. Used when a
    /// `map[K, V]` literal's (cref:TypeSymbol.ClrType) is null
    /// (e.g. `map[string, T]`) — the erased CLR fast-path is unavailable
    /// and the body construction must be parented at this reified TypeSpec so
    /// the value stored into the iterator state machine's reified
    /// `Dictionary<…, !0>` field verifies. Mirrors
    /// (cref:GetTupleTypeSpec(TupleTypeSymbol)).
    private func GetMapTypeSpec(mapType MapTypeSymbol) EntityHandle {
        let dictionaryOpen = typeof(System.Collections.Generic.Dictionary[_, _])
        let sigBlob = BlobBuilder()
        let genInst = BlobEncoder(sigBlob).TypeSpecificationSignature().GenericInstantiation(
            this.GetTypeReference(dictionaryOpen),
            genericArgumentCount: 2,
            isValueType: false
        )
        this.signatures.EncodeTypeSymbol(genInst.AddArgument(), mapType.KeyType)
        this.signatures.EncodeTypeSymbol(genInst.AddArgument(), mapType.ValueType)
        return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// Issue #1481: gets a MemberRef for the parameterless
    /// `Dictionary`2::.ctor()` parented at the reified
    /// (cref:GetMapTypeSpec) TypeSpec, for a `map[K, V]` literal
    /// whose (cref:TypeSymbol.ClrType) is null. Mirrors
    /// (cref:GetTupleCtorReference(TupleTypeSymbol, int, int)).
    internal func GetMapCtorReference(mapType MapTypeSymbol) MemberReferenceHandle {
        let parent = this.GetMapTypeSpec(mapType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (_ ParametersEncoder) -> { }
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// Issue #1481: gets a MemberRef for
    /// `Dictionary`2::set_Item(!0, !1)` parented at the reified
    /// (cref:GetMapTypeSpec) TypeSpec, used to populate a
    /// `map[K, V]` literal whose (cref:TypeSymbol.ClrType) is null.
    /// The parameter signature references the dictionary's own generic
    /// parameters (`!0`/`!1`), as required for a MemberRef on a
    /// constructed generic type.
    internal func GetMapSetItemReference(mapType MapTypeSymbol) MemberReferenceHandle {
        let parent = this.GetMapTypeSpec(mapType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                ps.AddParameter().Type().GenericTypeParameter(0)
                ps.AddParameter().Type().GenericTypeParameter(1)
            }
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("set_Item"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// Issue #3301: gets a MemberRef for
    /// `Dictionary`2::TryGetValue(!0, out !1)` parented at the reified
    /// (cref:GetMapTypeSpec) TypeSpec, for a `map[K, V]` index
    /// read whose (cref:TypeSymbol.ClrType) is null — a map keyed or
    /// valued by a same-compilation user struct (or an in-scope type
    /// parameter, #1481). Mirrors (cref:GetMapSetItemReference).
    /// @param mapType The map type whose backing dictionary is read.
    /// @returns The `TryGetValue` MemberRef handle.
    internal func GetMapTryGetValueReference(mapType MapTypeSymbol) MemberReferenceHandle {
        let parent = this.GetMapTypeSpec(mapType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            returnType: (r ReturnTypeEncoder) -> r.Type().Boolean(),
            parameters: (ps ParametersEncoder) -> {
                ps.AddParameter().Type().GenericTypeParameter(0)
                ps.AddParameter().Type(isByRef: true).GenericTypeParameter(1)
            }
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("TryGetValue"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// Issue #3301: gets a MemberRef for `Dictionary`2::Remove(!0)`
    /// parented at the reified (cref:GetMapTypeSpec) TypeSpec, for a
    /// `delete(m, k)` on a `map[K, V]` whose
    /// (cref:TypeSymbol.ClrType) is null. Mirrors
    /// (cref:GetMapSetItemReference).
    /// @param mapType The map type whose backing dictionary is mutated.
    /// @returns The `Remove` MemberRef handle.
    internal func GetMapRemoveReference(mapType MapTypeSymbol) MemberReferenceHandle {
        let parent = this.GetMapTypeSpec(mapType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            returnType: (r ReturnTypeEncoder) -> r.Type().Boolean(),
            parameters: (ps ParametersEncoder) -> ps.AddParameter().Type().GenericTypeParameter(0)
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("Remove"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// Issue #3301: gets a MemberRef for `Dictionary`2::get_Count()`
    /// parented at the reified (cref:GetMapTypeSpec) TypeSpec, for a
    /// `len(m)` on a `map[K, V]` whose
    /// (cref:TypeSymbol.ClrType) is null. Mirrors
    /// (cref:GetMapSetItemReference).
    /// @param mapType The map type whose backing dictionary is counted.
    /// @returns The `get_Count` MemberRef handle.
    internal func GetMapGetCountReference(mapType MapTypeSymbol) MemberReferenceHandle {
        let parent = this.GetMapTypeSpec(mapType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            returnType: (r ReturnTypeEncoder) -> r.Type().Int32(),
            parameters: (_ ParametersEncoder) -> { }
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("get_Count"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    internal func GetRectangularArrayTypeSpec(arrayType RectangularArrayTypeSymbol) TypeSpecificationHandle {
        let sigBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), arrayType)
        return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    internal func GetRectangularArrayMemberReference(
        arrayType RectangularArrayTypeSymbol,
        name string
    ) MemberReferenceHandle {
        let parent = this.GetRectangularArrayTypeSpec(arrayType)
        let sigBlob = BlobBuilder()
        let signature = BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
        if name == ".ctor" {
            signature.Parameters(
                arrayType.Rank,
                returnType: (r ReturnTypeEncoder) -> r.Void(),
                parameters: (ps ParametersEncoder) -> {
                    for var i = 0; i < arrayType.Rank; i++ {
                        ps.AddParameter().Type().Int32()
                    }
                }
            )
        } else {
            let parameterCount = arrayType.Rank +
                (
                if name == "Set" {
                    1
                } else {
                    0
                }
            )
            signature.Parameters(
                parameterCount,
                returnType: (r ReturnTypeEncoder) -> {
                    if name == "Set" {
                        r.Void()
                    } else {
                        this.signatures.EncodeTypeSymbol(r.Type(isByRef: name == "Address"), arrayType.ElementType)
                    }
                },
                parameters: (ps ParametersEncoder) -> {
                    for var i = 0; i < arrayType.Rank; i++ {
                        ps.AddParameter().Type().Int32()
                    }
                    if name == "Set" {
                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(), arrayType.ElementType)
                    }
                }
            )
        }
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent,
            this.emitCtx.Metadata.GetOrAddString(name),
            this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    // ADR-0087 §3 R6: cache reified delegate metadata by function shape and
    // the active generic-remap scope (issue #3163). The same interned
    // FunctionTypeSymbol can encode as VAR inside a synthesized generic class
    // and MVAR at its outer generic-method use site.
    private let functionDelegateTypeSpecCache Dictionary[
        (Type FunctionTypeSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Type FunctionTypeSymbol, Scope RemapScope), EntityHandle]()

    private let functionDelegateCtorRefCache Dictionary[
        (Type FunctionTypeSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Type FunctionTypeSymbol, Scope RemapScope), EntityHandle]()
    private let functionDelegateInvokeRefCache Dictionary[
        (Type FunctionTypeSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Type FunctionTypeSymbol, Scope RemapScope), EntityHandle]()

    private func GetFunctionDelegateCacheKey(fnType FunctionTypeSymbol)(Type FunctionTypeSymbol, Scope RemapScope) -> (
        fnType,
        this.remaps.CurrentScope
    )

    /// ADR-0087 §3 R6: returns a `TypeSpec` EntityHandle for the
    /// reified `Func<...>` / `Action<...>` shape
    /// backing [`fnType`](paramref). Type-parameter arguments encode
    /// as `Var(idx)` / `MVar(idx)`.
    internal func GetFunctionDelegateTypeSpec(fnType FunctionTypeSymbol) EntityHandle {
        let cacheKey = this.GetFunctionDelegateCacheKey(fnType)
        if this.functionDelegateTypeSpecCache.TryGetValue(cacheKey, out var cached) {
            return cached
        }
        let sigBlob = BlobBuilder()
        this.signatures.EncodeFunctionTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), fnType)
        let spec = EntityHandle(
            this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        )
        this.functionDelegateTypeSpecCache[cacheKey] = spec
        return spec
    }

    /// Issue #1330: returns the MemberRef handle for the canonical delegate
    /// `.ctor(object, IntPtr)` parented at the constructed-generic TypeSpec
    /// of [`symbolicDelegate`](paramref) — a delegate type closed over an
    /// in-scope generic type parameter (e.g. `Comparison<!TResult>`).
    /// Lets a function literal passed to a static generic factory
    /// (`Comparer[TResult].Create(...)`) materialise the exact delegate the
    /// callee expects rather than the natural `Func`/`Action` shape or
    /// the type-erased `Comparison<object>`.
    internal func GetConstructedDelegateCtorRef(symbolicDelegate ImportedTypeSymbol) EntityHandle {
        let parentBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(parentBlob).TypeSpecificationSignature(), symbolicDelegate)
        let parent = this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob))
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                ps.AddParameter().Type().Object()
                ps.AddParameter().Type().IntPtr()
            }
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// ADR-0087 §3 R6: returns the MemberRef handle for the reified
    /// delegate's `.ctor(object, IntPtr)`, parented at the
    /// `TypeSpec` for [`fnType`](paramref). Used by
    /// `EmitFunctionLiteral` / `EmitMethodGroup` when the
    /// function type contains type-parameter slots.
    internal func GetFunctionDelegateCtorRef(fnType FunctionTypeSymbol) EntityHandle {
        let cacheKey = this.GetFunctionDelegateCacheKey(fnType)
        if this.functionDelegateCtorRefCache.TryGetValue(cacheKey, out var cached) {
            return cached
        }
        let parent = this.GetFunctionDelegateTypeSpec(fnType)
        // Every Func/Action delegate exposes the canonical
        // .ctor(object target, IntPtr methodPtr) signature; identical
        // for every arity so no Var/MVar slots are needed.
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            returnType: (r ReturnTypeEncoder) -> r.Void(),
            parameters: (ps ParametersEncoder) -> {
                ps.AddParameter().Type().Object()
                ps.AddParameter().Type().IntPtr()
            }
        )
        let handle = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
        )
        this.functionDelegateCtorRefCache[cacheKey] = handle
        return handle
    }

    /// ADR-0087 §3 R6: returns the MemberRef handle for the reified
    /// delegate's `Invoke` method, parented at the `TypeSpec`
    /// for [`fnType`](paramref). The signature uses `VAR(i)`
    /// slots referencing the delegate type's own class-generic
    /// parameters (e.g. `Func`2::Invoke` is encoded as
    /// `!0 Invoke(!0)` wait — actually
    /// `!1 Invoke(!0)`). When the runtime resolves this MemberRef
    /// through the constructed parent `TypeSpec` (e.g.
    /// `Func<int32, int32>`), the VAR slots get substituted
    /// to the concrete arguments. No (cref:System.Delegate.DynamicInvoke)
    /// is required.
    internal func GetFunctionDelegateInvokeRef(fnType FunctionTypeSymbol) EntityHandle {
        let cacheKey = this.GetFunctionDelegateCacheKey(fnType)
        if this.functionDelegateInvokeRefCache.TryGetValue(cacheKey, out var cached) {
            return cached
        }
        let parent = this.GetFunctionDelegateTypeSpec(fnType)
        let isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType)
        let arity = fnType.ParameterTypes.Length
        // The MemberRef signature for a method on a generic TypeSpec
        // parent must reference the parent type's *class-generic*
        // type parameters via VAR slots (`!0`..`!N-1`). The runtime
        // substitutes them against the parent's instantiation when
        // dispatching the call. For Func`N the slots are
        // `(!0,...,!N-1) -> !N`; for Action`N they are
        // `(!0,...,!N-1) -> void`.
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            arity,
            returnType: (r ReturnTypeEncoder) -> {
                if isVoid {
                    r.Void()
                } else {
                    r.Type().GenericTypeParameter(arity)
                }
            },
            parameters: (ps ParametersEncoder) -> {
                for var i = 0; i < arity; i++ {
                    ps.AddParameter().Type().GenericTypeParameter(i)
                }
            }
        )
        let handle = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString("Invoke"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
        )
        this.functionDelegateInvokeRefCache[cacheKey] = handle
        return handle
    }

    // Issue #1502: the async delegate equivalent of FunctionTypeNeedsSymbolicDelegate.
    // For an async lambda materialised as a CLR delegate (`Func<...,Task<T>>`),
    // ResolveAsyncDelegateClrType wraps the return in Task<T> via
    // MapToReferenceClrType — which erases a source-defined user type or a
    // type-parameter result (e.g. `Task<TOutput>` for `Mp4Operation`1::
    // SetContinuation`) to `Task<object>`. When the Task-wrapped delegate shape
    // needs symbolic encoding, return the MemberRef for its reified
    // `.ctor(object, IntPtr)` parented at the `Func<...,Task<T>>` TypeSpec;
    // otherwise return null so the caller keeps the reflection path.
    internal func TryGetSymbolicAsyncDelegateCtorRef(fnType FunctionTypeSymbol, function FunctionSymbol) EntityHandle? {
        var plan AsyncStateMachinePlan? = nil
        for p in this.outer.stateMachines.AsyncStateMachinePlans {
            if p.KickoffMethod == function {
                plan = p
                break
            }
        }
        if plan == nil {
            return nil
        }
        let builderInfo = plan.StateMachine.BuilderInfo
        // async void → Action shape (no Task<T> wrapping). Symbolic only when a
        // parameter is itself user-defined / type-parameter-bearing.
        if builderInfo.Kind == AsyncMethodBuilderKind.Void {
            let voidFn = FunctionTypeSymbol.Get(fnType.ParameterTypes, TypeSymbol.Void)
            return if this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(voidFn) {
                this.GetFunctionDelegateCtorRef(voidFn)
            } else {
                default(EntityHandle?)
            }
        }
        if builderInfo
            .TaskProperty
            ?.PropertyType is not Type taskClrType ||
            plan
            .StateMachine
            .ResultTypeSymbol is not TypeSymbol resultSym {
            return nil
        }
        let taskReturn TypeSymbol = if taskClrType.IsConstructedGenericType {
            ImportedTypeSymbol.GetConstructed(
                taskClrType,
                taskClrType.GetGenericTypeDefinition(),
                ImmutableArray.Create(resultSym)
            )
        } else {
            ImportedTypeSymbol.GetWithoutNullability(taskClrType, NullabilityFreeReason.EmitShape)
        }
        let asyncFn = FunctionTypeSymbol.Get(fnType.ParameterTypes, taskReturn)
        return if this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(asyncFn) {
            this.GetFunctionDelegateCtorRef(asyncFn)
        } else {
            default(EntityHandle?)
        }
    }

    shared {
        /// Issue #3678: the user-declared generic DEFINITION behind
        /// [`type`](paramref) — a type that declares type parameters and
        /// supplies no type arguments — or `false` for anything
        /// else (a constructed instantiation, a non-generic type, an imported
        /// CLR type, which already carries its own open (cref:Type)).
        /// @param type The candidate type.
        /// @param definition The open generic definition on success.
        /// @returns Whether [`type`](paramref) is an open user generic definition.
        private func TryGetOpenGenericDefinition(type TypeSymbol, @NotNullWhen(true) out definition TypeSymbol?) bool {
            definition = switch type {
                case StructSymbol{IsGenericDefinition: true} structSym: cast[TypeSymbol](structSym)
                case InterfaceSymbol{IsGenericDefinition: true} interfaceSym: cast[TypeSymbol](interfaceSym)
                case DelegateTypeSymbol{IsGenericDefinition: true} delegateSym: cast[TypeSymbol](delegateSym)
                default: nil
            }
            return definition != nil
        }

        /// Returns `true` if [`type`](paramref) is a core base type from
        /// `System.Private.CoreLib` that is publicly exposed through
        /// `System.Runtime`. These types are used as base types in TypeDef
        /// rows and must reference the public facade so external consumers can
        /// resolve them.
        private func IsCoreLibBaseType(type Type) bool {
            if !string.Equals(
                type.Assembly.GetName().Name,
                "System.Private.CoreLib",
                StringComparison.OrdinalIgnoreCase
            ) {
                return false
            }
            let fullName = type.FullName
            return fullName == "System.Object" ||
                fullName == "System.ValueType" ||
                fullName == "System.Enum" ||
                fullName == "System.Attribute" ||
                fullName == "System.MulticastDelegate" ||
                fullName == "System.Delegate" ||
                fullName == "System.Type" ||
                fullName == "System.Runtime.CompilerServices.IsExternalInit" ||
                fullName == "System.Nullable`1" ||
                fullName == "System.ValueTuple`1" ||
                fullName == "System.ValueTuple`2" ||
                fullName == "System.ValueTuple`3" ||
                fullName == "System.ValueTuple`4" ||
                fullName == "System.ValueTuple`5" ||
                fullName == "System.ValueTuple`6" ||
                fullName == "System.ValueTuple`7" ||
                fullName == "System.ValueTuple`8" ||
                fullName == "System.IDisposable" ||
                fullName == "System.Collections.IEnumerable" ||
                fullName == "System.Collections.IEnumerator" ||
                fullName == "System.Collections.Generic.IEnumerable`1" ||
                fullName == "System.Collections.Generic.IEnumerator`1" ||
                fullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                fullName == "System.Collections.Generic.IAsyncEnumerator`1"
        }

        /// Issue #3718: projects a host-runtime (cref:Type) — one produced by
        /// a compiler-internal `typeof(...)` rather than resolved from the
        /// compilation's references — onto the equivalent type from
        /// [`references`](paramref), so its TypeRef is scoped to the reference
        /// closure's contract assembly instead of the hosting runtime's
        /// implementation assembly.
        /// @remarks Returns `false` — leaving the caller on the host identity
        /// — whenever projection is unnecessary or impossible: the type already came
        /// from a (cref:System.Reflection.MetadataLoadContext) (reflection-only
        /// assemblies are by construction inside the closure), the resolver has no
        /// load context at all (the in-process/TPA path, where the host type *is* the
        /// reference type), the type is a shape with no resolvable full name
        /// (generic parameter, array/byref/pointer, constructed generic — those are
        /// projected element-wise by their own encoders), or the references simply do
        /// not carry the type.
        /// @param references The compilation's reference resolver.
        /// @param type The candidate host type.
        /// @param projected The reference-set type, when one was found.
        /// @returns `true` when [`projected`](paramref) was set.
        private func TryProjectOntoReferences(
            references ReferenceResolver,
            type Type,
            @NotNullWhen(true) out projected Type?
        ) bool {
            projected = nil
            if type
                .Assembly
                .ReflectionOnly ||
                type.IsGenericParameter ||
                type.HasElementType ||
                type.IsConstructedGenericType {
                return false
            }
            if type.FullName is not{Length: > 0} fullName {
                return false
            }
            if !references.TryResolveType(fullName, requireExternalVisibility: false, out var resolved) ||
                object.ReferenceEquals(resolved, type) {
                return false
            }
            // A non-reflection-only answer means the resolver searched the host's
            // own runtime assemblies (ReferenceResolver.Default). Projecting there
            // would be a no-op at best and a cross-identity swap at worst.
            if !resolved!!.Assembly.ReflectionOnly {
                return false
            }
            projected = resolved
            return true
        }

        /// For a method on a constructed generic type, return the corresponding
        /// method on the open generic definition; for non-generic declaring types,
        /// returns the input. The open method's parameter / return types reference
        /// the declaring type's generic parameters as `GenericTypeParameter`,
        /// which (cref:SignatureEncoder.EncodeClrType) emits as `!N`.
        @return: NotNullIfNotNull("method")
        private func GetOpenMethod(method MethodInfo?) MethodInfo? {
            if method == nil {
                return nil
            }
            let declaring Type? = method.DeclaringType
            if declaring == nil || !declaring.IsConstructedGenericType {
                return method
            }
            let open_ = declaring.GetGenericTypeDefinition()
            for candidate in open_.GetMethods(
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if SameMetadataDefinition(candidate, method) {
                    return candidate
                }
            }
            let parameters = method.GetParameters()
            var fallback MethodInfo? = nil
            for candidate in open_.GetMethods(
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if candidate.Name == method.Name &&
                    candidate.IsStatic == method.IsStatic &&
                    candidate.IsGenericMethod == method.IsGenericMethod &&
                    candidate
                    .GetParameters().Length == parameters.Length {
                    fallback = candidate
                    break
                }
            }
            if fallback != nil {
                return fallback
            }
            return method
        }

        @return: NotNullIfNotNull("ctor")
        private func GetOpenCtor(ctor ConstructorInfo?) ConstructorInfo? {
            if ctor == nil {
                return nil
            }
            let declaring Type? = ctor.DeclaringType
            if declaring == nil || !declaring.IsConstructedGenericType {
                return ctor
            }
            let open_ = declaring.GetGenericTypeDefinition()
            for candidate in open_.GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if SameMetadataDefinition(candidate, ctor) {
                    return candidate
                }
            }
            let parameters = ctor.GetParameters()
            var fallback ConstructorInfo? = nil
            for candidate in open_.GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if candidate.GetParameters().Length == parameters.Length {
                    fallback = candidate
                    break
                }
            }
            if fallback != nil {
                return fallback
            }
            return ctor
        }

        internal func SameMetadataDefinition(candidate MemberInfo, member MemberInfo) bool {
            try {
                return candidate.MetadataToken == member.MetadataToken && candidate.Module == member.Module
            } catch (NotSupportedException) {
                return false
            } catch (InvalidOperationException) {
                return false
            }
        }

        private func ContainsTypeBuilderGenericArgument(type Type?) bool {
            if type == nil {
                return false
            }
            if type is TypeBuilder {
                return true
            }
            if type.HasElementType {
                return ContainsTypeBuilderGenericArgument(type.GetElementType())
            }
            if !type.IsGenericType {
                return false
            }
            try {
                return type.GetGenericArguments().Any(ContainsTypeBuilderGenericArgument)
            } catch (NotSupportedException) {
                return false
            }
        }

        @return: NotNullIfNotNull("method")
        private func ResolveTypeBuilderConstructedGenericMethod(method MethodInfo?) MethodInfo? {
            let declaring Type? = method?.DeclaringType
            if declaring == nil ||
                !declaring.IsConstructedGenericType ||
                !ContainsTypeBuilderGenericArgument(declaring) {
                return method
            }
            let openMethod MethodInfo? = GetOpenMethod(method)
            return if openMethod != nil && openMethod.DeclaringType?.IsGenericTypeDefinition == true {
                TypeBuilder.GetMethod(declaring, openMethod)
            } else {
                method
            }
        }

        @return: NotNullIfNotNull("ctor")
        private func ResolveTypeBuilderConstructedGenericCtor(ctor ConstructorInfo?) ConstructorInfo? {
            let declaring Type? = ctor?.DeclaringType
            if declaring == nil ||
                !declaring.IsConstructedGenericType ||
                !ContainsTypeBuilderGenericArgument(declaring) {
                return ctor
            }
            let openCtor ConstructorInfo? = GetOpenCtor(ctor)
            return if openCtor != nil && openCtor.DeclaringType?.IsGenericTypeDefinition == true {
                TypeBuilder.GetConstructor(declaring, openCtor)
            } else {
                ctor
            }
        }

        @return: NotNullIfNotNull("field")
        private func ResolveTypeBuilderConstructedGenericField(field FieldInfo?) FieldInfo? {
            if field == nil {
                return nil
            }
            let declaring Type? = field.DeclaringType
            if !ContainsTypeBuilderGenericArgument(declaring) ||
                declaring == nil ||
                !declaring.IsConstructedGenericType {
                return field
            }
            let openType = declaring.GetGenericTypeDefinition()
            let openField FieldInfo? = openType.GetField(
                field.Name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            return if openField != nil {
                TypeBuilder.GetField(declaring, openField)
            } else {
                field
            }
        }

        internal func GetTypeBuilderSafePropertyAccessor(
            property PropertyInfo?,
            wantSetter bool,
            nonPublic bool = false
        ) MethodInfo? {
            let declaring Type? = property?.DeclaringType
            if !ContainsTypeBuilderGenericArgument(declaring) ||
                declaring == nil ||
                !declaring
                .IsConstructedGenericType {
                return if wantSetter {
                    property?.GetSetMethod(nonPublic)
                } else {
                    property?.GetGetMethod(nonPublic)
                }
            }
            let openProperty = ResolvePropertyOnOpenDefinition(declaring.GetGenericTypeDefinition(), property)
            let openAccessor MethodInfo? = if wantSetter {
                openProperty?.GetSetMethod(nonPublic)
            } else {
                openProperty?.GetGetMethod(nonPublic)
            }
            return if openAccessor != nil {
                TypeBuilder.GetMethod(declaring, openAccessor)
            } else {
                default(MethodInfo?)
            }
        }

        /// Walks [`openDefinition`](paramref)'s implemented interfaces and
        /// returns the constructed instance that uses
        /// [`targetOpenInterface`](paramref) as its open definition. The
        /// returned (cref:Type)'s generic arguments are still in terms of
        /// [`openDefinition`](paramref)'s generic parameters so they can be
        /// substituted via (cref:MemberLookup.MapOpenClrTypeToSymbolic(Type, Type,
        /// ImmutableArray{TypeSymbol})).
        private func TryFindImplementedInterfaceInstantiation(
            openDefinition Type,
            targetOpenInterface Type,
            @NotNullWhen(true) out instantiation Type?
        ) bool {
            for iface in openDefinition.GetInterfaces() {
                if iface.IsGenericType &&
                    SameOpenTypeDefinition(iface.GetGenericTypeDefinition(), targetOpenInterface) {
                    instantiation = iface
                    return true
                }
                if !iface.IsGenericType && SameOpenTypeDefinition(iface, targetOpenInterface) {
                    instantiation = iface
                    return true
                }
            }
            instantiation = nil
            return false
        }

        /// Issue #1462: compares two generic type definitions (or non-generic
        /// types) for metadata identity rather than CLR reference identity. The
        /// receiver's `OpenDefinition` and the interfaces it implements are
        /// loaded through the (cref:System.Reflection.MetadataLoadContext)
        /// of the referenced framework, whereas the well-known method's
        /// (cref:MemberInfo.DeclaringType) may have been obtained via the
        /// compiler's own runtime `typeof(...)` (e.g.
        /// `typeof(IEnumerable<object>)` in the foreach lowerer). Those
        /// two (cref:Type) objects describe the same logical type but are
        /// never reference-equal, so a `==` comparison silently fails and the
        /// interface-substitution redirect is skipped — emitting the receiver's own
        /// hiding member (e.g. `List<T>`'s struct-returning
        /// `GetEnumerator`) typed as the interface enumerator, which is
        /// unverifiable. Comparing by (cref:Type.FullName) closes that gap.
        private func SameOpenTypeDefinition(a Type?, b Type?) bool {
            if a == nil || b == nil {
                return false
            }
            if a == b {
                return true
            }
            return a.FullName != nil && a.FullName == b.FullName
        }

        /// Issue #774: normalises any receiver type that carries open generic
        /// arguments (an (cref:ImportedTypeSymbol) with
        /// (cref:ImportedTypeSymbol.OpenDefinition), a
        /// (cref:SequenceTypeSymbol) with no (cref:TypeSymbol.ClrType),
        /// or its async counterpart) into the open CLR definition plus the
        /// symbolic argument list. Lets the symbolic-container MemberRef path
        /// fire uniformly for all three shapes.
        internal func TryNormalizeToSymbolicContainer(
            containingTypeSymbol TypeSymbol?,
            @NotNullWhen(true) out openDefinition Type?,
            out typeArguments ImmutableArray[TypeSymbol]
        ) bool {
            switch containingTypeSymbol {
                case userType is StructSymbol {
                    for current in userType.GetHierarchy() {
                        if current.ImportedBaseType != nil &&
                            TryNormalizeToSymbolicContainer(
                            current.ImportedBaseType,
                            out openDefinition,
                            out typeArguments
                        ) {
                            return true
                        }
                    }
                    openDefinition = nil
                    typeArguments = default(ImmutableArray[TypeSymbol])
                    return false
                }
                case imp is ImportedTypeSymbol when imp.OpenDefinition != nil && !imp.TypeArguments.IsDefaultOrEmpty {
                    openDefinition = imp.OpenDefinition
                    typeArguments = imp.TypeArguments
                    return true
                }
                case seq is SequenceTypeSymbol {
                    openDefinition = typeof(System.Collections.Generic.IEnumerable[_])
                    typeArguments = ImmutableArray.Create[TypeSymbol](seq.ElementType)
                    return true
                }
                case aseq is AsyncSequenceTypeSymbol {
                    openDefinition = typeof(System.Collections.Generic.IAsyncEnumerable[_])
                    typeArguments = ImmutableArray.Create[TypeSymbol](aseq.ElementType)
                    return true
                }
                case nul is NullableTypeSymbol when nul.UnderlyingType is TypeParameterSymbol &&
                    (cast[TypeParameterSymbol](nul.UnderlyingType))
                    .HasValueTypeConstraint {
                    // Issue #806: a `T?` receiver where T is an open value-type
                    // type parameter has no constructed CLR `Nullable<T>` here —
                    // route member-ref encoding through the symbolic container
                    // path so the MemberRef parent is `Nullable<!!T>` against
                    // System.Runtime, not against the current assembly.
                    openDefinition = typeof(System.Nullable[_])
                    typeArguments = ImmutableArray.Create[TypeSymbol](cast[TypeParameterSymbol](nul.UnderlyingType))
                    return true
                }
                case nullableReference is NullableTypeSymbol when !NullableLifting.IsAnyValueTypeNullable(
                    nullableReference
                ) {
                    // Issue #3501 (ilverify): a nullable REFERENCE receiver — e.g.
                    // an iterator-hoisted `IEnumerable[Item]?` local narrowed
                    // non-null before the loop — shares its underlying type's
                    // runtime container; without the unwrap the member ref falls
                    // back to the erased closed shape while sibling state-machine
                    // fields reify, and the two disagree at verification.
                    return TryNormalizeToSymbolicContainer(
                        nullableReference.UnderlyingType,
                        out openDefinition,
                        out typeArguments
                    )
                }
                case annotated is NullabilityAnnotatedTypeSymbol {
                    return TryNormalizeToSymbolicContainer(annotated.BaseType, out openDefinition, out typeArguments)
                }
                case map_ is MapTypeSymbol when map_.ClrType == nil {
                    // Issue #3311: a `map[K, V]` receiver over type-parameter (or
                    // other not-yet-loadable) arguments has no closed CLR
                    // Dictionary here — parent its interop member refs at the
                    // symbolic `Dictionary<!K, !V>` TypeSpec. This is the
                    // general-member counterpart of the dedicated #1481/#3306 map
                    // helpers (GetMapCtorReference / GetMapTryGetValueReference /
                    // …), covering the whole reflected member surface
                    // (ContainsKey, Keys, Count, GetEnumerator, …) that binding
                    // now resolves through the symbolic Dictionary view
                    // (MemberLookup.TryGetSymbolicOpenMapReceiverView).
                    openDefinition = typeof(System.Collections.Generic.Dictionary[_, _])
                    typeArguments = ImmutableArray.Create(map_.KeyType, map_.ValueType)
                    return true
                }
                default {
                    openDefinition = nil
                    typeArguments = default(ImmutableArray[TypeSymbol])
                    return false
                }
            }
        }

        internal func ResolveMethodOnOpenDefinition(openDefinition Type?, method MethodInfo) MethodInfo? {
            if openDefinition == nil {
                return method
            }
            if method.DeclaringType == openDefinition {
                return method
            }
            for candidate in openDefinition.GetMethods(
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if SameMetadataDefinition(candidate, method) {
                    return candidate
                }
            }
            var fallback MethodInfo? = nil
            for candidate in openDefinition.GetMethods(
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if candidate.Name == method.Name &&
                    candidate.IsStatic == method.IsStatic &&
                    candidate.IsGenericMethod == method.IsGenericMethod &&
                    candidate
                    .GetParameters().Length == method.GetParameters().Length {
                    fallback = candidate
                    break
                }
            }
            return fallback ?? method
        }

        internal func ResolvePropertyOnOpenDefinition(openDefinition Type?, property PropertyInfo?) PropertyInfo? {
            if property == nil {
                return nil
            }
            if openDefinition == nil {
                return property
            }
            if property.DeclaringType == openDefinition {
                return property
            }
            for candidate in openDefinition.GetProperties(
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if SameMetadataDefinition(candidate, property) {
                    return candidate
                }
            }
            return openDefinition.GetProperty(
                property.Name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
        }

        private func ResolveCtorOnOpenDefinition(openDefinition Type?, ctor ConstructorInfo) ConstructorInfo {
            if openDefinition == nil {
                return ctor
            }
            if ctor.DeclaringType == openDefinition {
                return ctor
            }
            for candidate in openDefinition.GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if SameMetadataDefinition(candidate, ctor) {
                    return candidate
                }
            }
            var fallback ConstructorInfo? = nil
            for candidate in openDefinition.GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            ) {
                if candidate.GetParameters().Length == ctor.GetParameters().Length {
                    fallback = candidate
                    break
                }
            }
            return fallback ?? ctor
        }
    }
}
