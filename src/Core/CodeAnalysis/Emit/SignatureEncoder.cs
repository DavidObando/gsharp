// <copyright file="SignatureEncoder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'internal' members should come before 'private' members (methods keep their original ReflectionMetadataEmitter band order: entry points interleaved with the private helpers they orchestrate)
#pragma warning disable SA1204 // static members should come before non-static (the calling-convention/task-type helpers sit next to the encoders that consume them, preserving band order)
#pragma warning disable SA1214 // readonly fields should appear before non-readonly fields (the delegate-shape caches keep their original ReflectionMetadataEmitter band position)
#pragma warning disable SA1515 // single-line comment preceded by blank line (inherited from the ReflectionMetadataEmitter band; bodies are verbatim moves)
#pragma warning disable SA1611 // parameter documentation missing — the API surface is mechanically lifted from ReflectionMetadataEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-17 (#1361): the signature / type-encoding band. Owns every method that
/// renders a G# <see cref="TypeSymbol"/> (or a reflection <see cref="Type"/>)
/// into an ECMA-335 signature blob — the core of the emitter's metadata output.
/// Covers the recursive <c>EncodeTypeSymbol</c> / <c>EncodeClrType</c> pair, the
/// return-type and local-variable encoders, the reified delegate
/// (<c>Func</c>/<c>Action</c>) shape encoder, the function-pointer call-site
/// signature, and the host→reference-context CLR type resolution the reflection
/// encoding path depends on
/// (<c>ResolveDelegateClrType</c> / <c>ResolveAsyncDelegateClrType</c> /
/// <c>MapToReferenceClrType</c>).
/// </summary>
/// <remarks>
/// <para>
/// Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// InterfaceImplEmitter idiom) because the band reaches
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>,
/// <see cref="GenericRemapState"/>, AND several user-token resolvers that only
/// move in later PRs (<see cref="ImportedMemberRefFactory.GetTypeReference"/>,
/// <c>ResolveUserStructTypeSpecArguments</c>, <c>ResolveDelegateTypeArguments</c>,
/// and the async-state-machine plans on
/// <see cref="ReflectionMetadataEmitter.stateMachines"/>). Those temporary
/// couplings are reached through <see cref="outer"/> and are resolved when the
/// token-resolution band is extracted (E-18/E-19). Direct convenience fields
/// hold the shared <see cref="EmitContext"/> / <see cref="MetadataTokenCache"/>
/// / <see cref="GenericRemapState"/> read off the back-reference.
/// </para>
/// <para>
/// The active-remap reads route through
/// <see cref="GenericRemapState.ActiveIteratorStateMachineRemap"/> /
/// <see cref="GenericRemapState.ActiveLambdaMethodTypeParamRemap"/>; the getter
/// returns the same live Dictionary reference the emitter mutates, so it is
/// read (never snapshotted) exactly as the pre-E-17 band did. Method bodies are
/// verbatim moves; emitted PEs are byte-identical with the pre-E-17 baseline.
/// </para>
/// </remarks>
internal sealed class SignatureEncoder
{
    private readonly ReflectionMetadataEmitter outer;
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly GenericRemapState remaps;

    public SignatureEncoder(ReflectionMetadataEmitter outer)
    {
        this.outer = outer ?? throw new ArgumentNullException(nameof(outer));
        this.emitCtx = outer.emitCtx;
        this.cache = outer.cache;
        this.remaps = outer.remaps;
    }

    internal void EncodeLocalVariableType(LocalVariableTypeEncoder enc, TypeSymbol t)
    {
        // ADR-0125 / issue #1026: a `fixed` statement's pinned local carries the
        // CLR `pinned` flag so the GC cannot relocate the pinned buffer. The
        // underlying storage is either a managed by-ref (`T& pinned`, string
        // form) or an ordinary managed type such as the array (`T[] pinned`,
        // array form).
        if (t is PinnedTypeSymbol pinned)
        {
            if (pinned.UnderlyingType is ByRefTypeSymbol pinnedByRef)
            {
                EncodeTypeSymbol(enc.Type(isByRef: true, isPinned: true), pinnedByRef.PointeeType);
            }
            else
            {
                EncodeTypeSymbol(enc.Type(isByRef: false, isPinned: true), pinned.UnderlyingType);
            }

            return;
        }

        if (t is ByRefTypeSymbol byRef)
        {
            EncodeTypeSymbol(enc.Type(isByRef: true), byRef.PointeeType);
        }
        else
        {
            EncodeTypeSymbol(enc.Type(), t);
        }
    }

    internal void EncodeTypeSymbol(SignatureTypeEncoder encoder, TypeSymbol type)
    {
        // ADR-0122 / issue #1014: an *unmanaged* pointer type (PointerTypeSymbol
        // → CLR ELEMENT_TYPE_PTR) is encoded by emitting the `*` element-type
        // prefix and recursing on the pointee. Unlike ELEMENT_TYPE_BYREF this is
        // a valid SignatureTypeEncoder element, so fields, parameters, returns,
        // and locals all flow through this branch uniformly.
        if (type is PointerTypeSymbol ptr)
        {
            var pointerEncoder = encoder.Pointer();

            // ADR-0122 §3 / issue #1033: `*void` (C# `void*`) encodes as
            // ELEMENT_TYPE_PTR over ELEMENT_TYPE_VOID. SignatureTypeEncoder has
            // no `Void()` helper (void is only valid as a return or pointee), so
            // write the raw ELEMENT_TYPE_VOID type-code byte after the pointer
            // prefix that `encoder.Pointer()` already emitted.
            if (ptr.PointeeType == TypeSymbol.Void)
            {
                pointerEncoder.Builder.WriteByte((byte)System.Reflection.Metadata.SignatureTypeCode.Void);
                return;
            }

            EncodeTypeSymbol(pointerEncoder, ptr.PointeeType);
            return;
        }

        // ADR-0060 §13 / migration: a managed-pointer type (ByRefTypeSymbol → T&) cannot
        // be encoded into a SignatureTypeEncoder slot because ELEMENT_TYPE_BYREF is a
        // parent-encoder concern. Callers in parameter / return / local positions must
        // request the byref form via the parent encoder (e.g. `ParameterTypeEncoder.Type(isByRef:true)`)
        // and then call EncodeTypeSymbol with the pointee type. The bug being fixed here
        // is that the previous code silently encoded `T&` as `T`, producing wrong CLR
        // signatures for `&T`-typed locals/fields/returns. Detect and fail loudly.
        if (type is ByRefTypeSymbol byRef)
        {
            throw new InvalidOperationException(
                $"Cannot encode '*{byRef.PointeeType.Name}' as a non-byref signature slot; "
                + "use the parent encoder's Type(isByRef: true) overload (parameter/return/local) "
                + "and pass the pointee type to EncodeTypeSymbol.");
        }

        // Phase 3 exit: `T?` for reference types is metadata-only (same CLR
        // signature as `T`). For value types it lowers to `Nullable<T>`.
        if (type is NullableTypeSymbol nullable)
        {
            var inner = nullable.UnderlyingType;

            // P2-7 / Issue #421: nullable over a value type encodes as
            // System.Nullable<T> (generic instantiation). We support inner
            // types backed by a CLR value type (primitives, BCL value types).
            if (inner?.ClrType is { IsValueType: true } innerClrVt)
            {
                // Issue #571: build Nullable<T> from the open `System.Nullable`1`
                // discovered through the ReferenceResolver so it shares the load
                // context of the inner value type. See GetElementTypeToken.
                if (!NullableLifting.TryConstructNullable(this.emitCtx.References, innerClrVt, out var nullableClr))
                {
                    throw new InvalidOperationException(
                        $"Cannot construct Nullable<{innerClrVt.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
                }

                this.EncodeClrType(encoder, nullableClr);
                return;
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
            if (inner is TypeParameterSymbol nullableTp && nullableTp.HasValueTypeConstraint)
            {
                var nullableOpen = typeof(System.Nullable<>);
                var giNullable = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(nullableOpen),
                    genericArgumentCount: 1,
                    isValueType: true);
                this.EncodeTypeSymbol(giNullable.AddArgument(), nullableTp);
                return;
            }

            if (inner is StructSymbol nestedStruct && !nestedStruct.IsClass)
            {
                // Issue #1475: `S?` over a user-declared value-type struct
                // lowers to `System.Nullable<S>` — a generic instantiation
                // whose single argument is the struct's emitted TypeDef (or a
                // GENERICINST for a constructed user-generic struct). Mirrors
                // the user-enum branch below and the struct-constrained
                // type-parameter branch above.
                var nestedStructDef = nestedStruct.Definition ?? nestedStruct;
                if (!this.cache.StructTypeDefs.ContainsKey(nestedStructDef))
                {
                    throw new InvalidOperationException(
                        $"Struct '{nestedStruct.Name}' has no emitted TypeDef.");
                }

                var nullableOpenForStruct = typeof(System.Nullable<>);
                var giNullableStruct = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(nullableOpenForStruct),
                    genericArgumentCount: 1,
                    isValueType: true);
                this.EncodeTypeSymbol(giNullableStruct.AddArgument(), nestedStruct);
                return;
            }

            if (inner is EnumSymbol nestedEnum)
            {
                // Issue #1298: `E?` over a user-declared enum lowers to
                // `System.Nullable<E>` — a generic instantiation whose single
                // argument is the enum's own emitted TypeDef. Mirrors the
                // struct-constrained type-parameter branch above.
                if (!this.cache.EnumTypeDefs.ContainsKey(nestedEnum))
                {
                    throw new InvalidOperationException(
                        $"Enum '{nestedEnum.Name}' has no emitted TypeDef.");
                }

                var nullableOpenForEnum = typeof(System.Nullable<>);
                var giNullableEnum = encoder.GenericInstantiation(
                    this.outer.memberRefs.GetTypeReference(nullableOpenForEnum),
                    genericArgumentCount: 1,
                    isValueType: true);
                this.EncodeTypeSymbol(giNullableEnum.AddArgument(), nestedEnum);
                return;
            }

            EncodeTypeSymbol(encoder, inner);
            return;
        }

        if (type == TypeSymbol.Bool)
        {
            encoder.Boolean();
        }
        else if (type == TypeSymbol.Int32)
        {
            encoder.Int32();
        }
        else if (type == TypeSymbol.String)
        {
            encoder.String();
        }
        else if (type == TypeSymbol.Void)
        {
            throw new InvalidOperationException("Use ReturnTypeEncoder.Void() for void returns.");
        }
        else if (type is TypeParameterSymbol tp)
        {
            // Issue #2118: inside a generic-promoted non-capturing lambda's
            // signature/body, references to the enclosing type parameters map to
            // the lambda method's own MVar(idx) slots.
            if (this.remaps.ActiveLambdaMethodTypeParamRemap != null
                && this.remaps.ActiveLambdaMethodTypeParamRemap.TryGetValue(tp, out var lambdaMethodOrd))
            {
                encoder.GenericMethodTypeParameter(lambdaMethodOrd);
            }

            // Issue #810: when emitting a state-machine method (or the
            // state-machine class itself), references to the OUTER
            // method's type parameters are encoded as the SM class's
            // own type parameters (Var(i)). This mirrors how Roslyn
            // emits `<Empty>d__0<T>` where the body's `!!0` becomes
            // `!0` on the SM class. The remap is pushed by
            // EmitIteratorStateMachineMember and is keyed by the
            // method TP's instance identity.
            else if (this.remaps.ActiveIteratorStateMachineRemap != null
                && tp.IsMethodTypeParameter
                && this.remaps.ActiveIteratorStateMachineRemap.TryGetValue(tp, out var classOrdinal))
            {
                encoder.GenericTypeParameter(classOrdinal);
            }

            // Issue #1477: a synthesized closure / capture-box class is generic
            // over enclosing TYPE parameters too, so any TP in the active remap
            // (class or method) encodes the synthesized class's own Var(idx).
            else if (this.remaps.ActiveIteratorStateMachineRemap != null
                && this.remaps.ActiveIteratorStateMachineRemap.TryGetValue(tp, out var classOrdinal2))
            {
                encoder.GenericTypeParameter(classOrdinal2);
            }

            // ADR-0087 §3 R2: a user-declared open type parameter encodes as
            // GenericTypeParameter(idx) (`Var(idx)`) when it belongs to a
            // generic type, or as GenericMethodTypeParameter(idx) (`MVar(idx)`)
            // when it belongs to a generic method. The
            // TypeParameterSymbol.IsMethodTypeParameter flag, set by the
            // FunctionSymbol.TypeParameters setter, discriminates the owner
            // kind without a back-reference cycle.
            else if (tp.IsMethodTypeParameter)
            {
                encoder.GenericMethodTypeParameter(tp.Ordinal);
            }
            else
            {
                encoder.GenericTypeParameter(tp.Ordinal);
            }
        }
        else if (type is ImportedTypeSymbol constructedImported
            && !constructedImported.TypeArguments.IsDefaultOrEmpty
            && constructedImported.OpenDefinition != null)
        {
            // Issue #2666: the cached CLR projection may be object-erased even
            // when every symbolic argument is concrete (for example the
            // KeyValuePair[K,V] cell captured by an async foreach body).
            var genericInst = encoder.GenericInstantiation(
                this.outer.memberRefs.GetTypeReference(constructedImported.OpenDefinition),
                constructedImported.TypeArguments.Length,
                isValueType: constructedImported.OpenDefinition.IsValueType);
            foreach (var arg in constructedImported.TypeArguments)
            {
                this.EncodeTypeSymbol(genericInst.AddArgument(), arg);
            }
        }
        else if (type is ArrayTypeSymbol arr)
        {
            EncodeTypeSymbol(encoder.SZArray(), arr.ElementType);
        }
        else if (type is SliceTypeSymbol slice)
        {
            EncodeTypeSymbol(encoder.SZArray(), slice.ElementType);
        }
        else if (type is SequenceTypeSymbol openSeq && openSeq.ClrType == null)
        {
            // Issue #773: an open `sequence[T]` (where T is an in-scope
            // type parameter) has no closed CLR type yet. Encode it as
            // `GENERICINST<IEnumerable`1><T>` so the resulting method
            // signature carries an honest `IEnumerable<MVar/Var>` slot
            // — same pattern as ADR-0087 §3 R2 for `ImportedTypeSymbol`
            // with `HasTypeParameterArgument`.
            var enumerableOpen = typeof(System.Collections.Generic.IEnumerable<>);
            var giSeq = encoder.GenericInstantiation(
                this.outer.memberRefs.GetTypeReference(enumerableOpen),
                1,
                isValueType: false);
            this.EncodeTypeSymbol(giSeq.AddArgument(), openSeq.ElementType);
        }
        else if (type is AsyncSequenceTypeSymbol openAseq && openAseq.ClrType == null)
        {
            // Mirror of the synchronous-sequence open-T encoding for
            // `async sequence[T]` (== IAsyncEnumerable<T>).
            var asyncEnumerableOpen = typeof(System.Collections.Generic.IAsyncEnumerable<>);
            var giAseq = encoder.GenericInstantiation(
                this.outer.memberRefs.GetTypeReference(asyncEnumerableOpen),
                1,
                isValueType: false);
            this.EncodeTypeSymbol(giAseq.AddArgument(), openAseq.ElementType);
        }
        else if (type is StructSymbol structSym)
        {
            if (structSym.ClrType != null)
            {
                this.EncodeClrType(encoder, structSym.ClrType);
                return;
            }

            // ADR-0087 §3 R2: a user-declared generic struct encodes as
            // GENERICINST<def><args>. For a constructed instance the args
            // come from TypeArguments; for the open definition itself we
            // emit the self-instantiation `Box`1<!0,!1,…>` so signatures
            // of synthesized members (Equals(typed), op_Equality, …)
            // round-trip correctly under verification.
            var defSym = structSym.Definition ?? structSym;
            if (!this.cache.StructTypeDefs.TryGetValue(defSym, out var typeDef))
            {
                throw new InvalidOperationException($"Struct '{defSym.Name}' has no emitted TypeDef.");
            }

            if (ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym))
            {
                var typeArgs = this.outer.userTokens.ResolveUserStructTypeSpecArguments(structSym, defSym);

                var gi = encoder.GenericInstantiation(typeDef, typeArgs.Length, isValueType: !defSym.IsClass);
                foreach (var arg in typeArgs)
                {
                    this.EncodeTypeSymbol(gi.AddArgument(), arg);
                }
            }
            else
            {
                encoder.Type(typeDef, isValueType: !structSym.IsClass);
            }
        }
        else if (type is EnumSymbol enumSym)
        {
            // Issue #193: a user-defined enum's signature surface is its
            // own TypeDef (a sealed value type derived from System.Enum).
            if (!this.cache.EnumTypeDefs.TryGetValue(enumSym, out var enumTypeDef))
            {
                throw new InvalidOperationException($"Enum '{enumSym.Name}' has no emitted TypeDef.");
            }

            encoder.Type(enumTypeDef, isValueType: true);
        }
        else if (type is InterfaceSymbol ifaceSym)
        {
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
            var ifaceDefSym = ifaceSym.Definition ?? ifaceSym;
            if (!this.cache.InterfaceTypeDefs.TryGetValue(ifaceDefSym, out var ifaceDef))
            {
                throw new InvalidOperationException($"Interface '{ifaceDefSym.Name}' has no emitted TypeDef.");
            }

            if (ReflectionMetadataEmitter.IsUserGenericInterfaceReference(ifaceSym))
            {
                ImmutableArray<TypeSymbol> ifaceTypeArgs;
                if (!ifaceSym.TypeArguments.IsDefaultOrEmpty)
                {
                    ifaceTypeArgs = ifaceSym.TypeArguments;
                }
                else
                {
                    var ifaceDefTps = ifaceDefSym.TypeParameters;
                    var ifaceBld = ImmutableArray.CreateBuilder<TypeSymbol>(ifaceDefTps.Length);
                    foreach (var defTp in ifaceDefTps)
                    {
                        ifaceBld.Add(defTp);
                    }

                    ifaceTypeArgs = ifaceBld.MoveToImmutable();
                }

                var ifaceGi = encoder.GenericInstantiation(ifaceDef, ifaceTypeArgs.Length, isValueType: false);
                foreach (var arg in ifaceTypeArgs)
                {
                    this.EncodeTypeSymbol(ifaceGi.AddArgument(), arg);
                }
            }
            else
            {
                encoder.Type(ifaceDef, isValueType: false);
            }
        }
        else if (type is DelegateTypeSymbol delegateSym)
        {
            // ADR-0059 / issue #255: a user-declared named delegate type
            // encodes as a reference type referring to its own TypeDef
            // (a sealed class deriving from System.MulticastDelegate).
            // Issue #1503: a GENERIC named delegate encodes as
            // GENERICINST<Predicate`1><args> — for a constructed instance the
            // args come from TypeArguments; for the open definition the
            // self-instantiation `Predicate`1<!0,…>` is emitted so member
            // signatures round-trip under verification, exactly as the generic
            // struct/interface branches do.
            var delegateDefSym = delegateSym.Definition ?? delegateSym;
            if (!this.cache.DelegateTypeDefs.TryGetValue(delegateDefSym, out var delegateDef))
            {
                throw new InvalidOperationException($"Delegate '{delegateDefSym.Name}' has no emitted TypeDef.");
            }

            if (delegateDefSym.TypeParameters.IsDefaultOrEmpty)
            {
                encoder.Type(delegateDef, isValueType: false);
            }
            else
            {
                var delegateTypeArgs = ReflectionMetadataEmitter.ResolveDelegateTypeArguments(delegateSym);
                var gi = encoder.GenericInstantiation(delegateDef, delegateTypeArgs.Length, isValueType: false);
                foreach (var arg in delegateTypeArgs)
                {
                    this.EncodeTypeSymbol(gi.AddArgument(), arg);
                }
            }
        }
        else if (type is ChannelTypeSymbol chType)
        {
            // Phase E: chan T -> System.Threading.Channels.Channel<T>.
            // For element types that lack a ClrType we erase to object,
            // matching the interpreter's `ElementType.ClrType ?? typeof(object)`
            // fallback (ADR-0022 §interpreter).
            var elementClr = chType.ElementType.ClrType ?? typeof(object);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            this.EncodeClrType(encoder, channelClr);
        }
        else if (type is TupleTypeSymbol tupleWithNullClr && tupleWithNullClr.ClrType == null)
        {
            // Issues #649/#2750: encode symbolic tuples recursively so arity
            // 8+ uses ValueTuple<T1,...,T7,TRest> without erasing elements.
            this.EncodeTupleType(encoder, tupleWithNullClr.ElementTypes, 0, tupleWithNullClr.Arity);
        }
        else if (type is FunctionPointerTypeSymbol fnPtr)
        {
            // ADR-0095 / issue #761: a raw function-pointer type encodes
            // as an ELEMENT_TYPE_FNPTR followed by a nested method
            // signature (calling convention + return + parameters). The
            // GS-level type is an address-sized integer at runtime, but
            // the metadata blob is rendered as FNPTR for type fidelity
            // so disassemblers and the verifier see the precise shape.
            var fnPtrConvention = MapToSignatureCallingConvention(fnPtr.CallingConvention);
            var fnPtrSig = encoder.FunctionPointer(fnPtrConvention, FunctionPointerAttributes.None, 0);
            fnPtrSig.Parameters(fnPtr.ParameterTypes.Length, out var fnRetEnc, out var fnParamsEnc);
            this.EncodeReturnSymbol(fnRetEnc, fnPtr.ReturnType);
            for (var i = 0; i < fnPtr.ParameterTypes.Length; i++)
            {
                this.EncodeTypeSymbol(fnParamsEnc.AddParameter().Type(), fnPtr.ParameterTypes[i]);
            }
        }
        else if (type is FunctionTypeSymbol fn)
        {
            // ADR-0087 §3 R6 / issue #2666: encode delegates from their symbolic shape.
            // A nested open slot (for example `async () -> T`) can still have
            // an object-erased ClrType (`Func<Task<object>>`); preferring that
            // cached projection corrupts generic async state-machine fields.
            // The reified signature retains the original nested Var/MVar slots.
            this.EncodeFunctionTypeSymbol(encoder, fn);
        }
        else if (type?.ClrType != null)
        {
            this.EncodeClrType(encoder, type.ClrType);
        }
        else if (type is MapTypeSymbol openMap)
        {
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
            var dictionaryOpen = typeof(System.Collections.Generic.Dictionary<,>);
            var giMap = encoder.GenericInstantiation(
                this.outer.memberRefs.GetTypeReference(dictionaryOpen),
                genericArgumentCount: 2,
                isValueType: false);
            this.EncodeTypeSymbol(giMap.AddArgument(), openMap.KeyType);
            this.EncodeTypeSymbol(giMap.AddArgument(), openMap.ValueType);
        }
        else
        {
            throw new NotSupportedException($"Cannot encode signature for type '{type?.Name}' yet.");
        }
    }

    private void EncodeTupleType(
        SignatureTypeEncoder encoder,
        ImmutableArray<TypeSymbol> elementTypes,
        int start,
        int count)
    {
        var physicalArity = count <= 7 ? count : 8;
        var genericInst = encoder.GenericInstantiation(
            this.outer.memberRefs.GetTypeReference(TupleTypeSymbol.GetOpenClrType(physicalArity)),
            physicalArity,
            isValueType: true);

        var directCount = Math.Min(count, 7);
        for (var i = 0; i < directCount; i++)
        {
            this.EncodeTypeSymbol(genericInst.AddArgument(), elementTypes[start + i]);
        }

        if (count > 7)
        {
            this.EncodeTupleType(genericInst.AddArgument(), elementTypes, start + 7, count - 7);
        }
    }

    /// <summary>
    /// ADR-0122 §9 / issue #1035: builds a standalone method signature for a
    /// function-pointer type, used as the operand of the CIL <c>calli</c>
    /// opcode. Managed function pointers use the default managed calling
    /// convention; unmanaged ones carry their declared ABI.
    /// </summary>
    /// <param name="fnPtr">The function-pointer type to sign.</param>
    /// <returns>A standalone signature handle for <c>calli</c>.</returns>
    internal StandaloneSignatureHandle GetFunctionPointerCallSiteSignature(FunctionPointerTypeSymbol fnPtr)
    {
        var convention = fnPtr.IsManaged
            ? System.Reflection.Metadata.SignatureCallingConvention.Default
            : MapToSignatureCallingConvention(fnPtr.CallingConvention);
        var sigBlob = new BlobBuilder();
        var sig = new BlobEncoder(sigBlob).MethodSignature(convention, 0, isInstanceMethod: false);
        sig.Parameters(fnPtr.ParameterTypes.Length, out var retEnc, out var paramsEnc);
        this.EncodeReturnSymbol(retEnc, fnPtr.ReturnType);
        for (var i = 0; i < fnPtr.ParameterTypes.Length; i++)
        {
            this.EncodeTypeSymbol(paramsEnc.AddParameter().Type(), fnPtr.ParameterTypes[i]);
        }

        return this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// ADR-0095 / issue #761: maps the
    /// <see cref="System.Runtime.InteropServices.CallingConvention"/>
    /// enum (used by <c>@DllImport</c> / <c>@UnmanagedFunctionPointer</c>
    /// declarations and by <see cref="FunctionPointerTypeSymbol"/>) to
    /// the metadata-level
    /// <see cref="System.Reflection.Metadata.SignatureCallingConvention"/>
    /// enum used when encoding an ELEMENT_TYPE_FNPTR signature blob.
    /// </summary>
    private static System.Reflection.Metadata.SignatureCallingConvention MapToSignatureCallingConvention(System.Runtime.InteropServices.CallingConvention convention)
    {
        return convention switch
        {
            System.Runtime.InteropServices.CallingConvention.Cdecl => System.Reflection.Metadata.SignatureCallingConvention.CDecl,
            System.Runtime.InteropServices.CallingConvention.StdCall => System.Reflection.Metadata.SignatureCallingConvention.StdCall,
            System.Runtime.InteropServices.CallingConvention.ThisCall => System.Reflection.Metadata.SignatureCallingConvention.ThisCall,
            System.Runtime.InteropServices.CallingConvention.FastCall => System.Reflection.Metadata.SignatureCallingConvention.FastCall,
            System.Runtime.InteropServices.CallingConvention.Winapi => System.Reflection.Metadata.SignatureCallingConvention.StdCall,
            _ => System.Reflection.Metadata.SignatureCallingConvention.CDecl,
        };
    }

    private void EncodeReturnSymbol(ReturnTypeEncoder encoder, TypeSymbol type)
        => EncodeReturnSymbol(encoder, type, RefKind.None);

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a function whose <see cref="FunctionSymbol.ReturnRefKind"/>
    /// is <see cref="RefKind.Ref"/> returns a managed pointer (<c>T&amp;</c>) — encode it via
    /// the <c>ReturnTypeEncoder.Type(isByRef: true, ...)</c> overload.
    /// </summary>
    internal void EncodeReturnSymbol(ReturnTypeEncoder encoder, TypeSymbol type, RefKind returnRefKind)
    {
        if (type == TypeSymbol.Void)
        {
            encoder.Void();
        }
        else
        {
            this.EncodeTypeSymbol(encoder.Type(isByRef: returnRefKind == RefKind.Ref), type);
        }
    }

    internal void EncodeClrType(SignatureTypeEncoder encoder, Type type)
    {
        // ADR-0060 §13 / migration: same as EncodeTypeSymbol — a CLR `T&` (Type.IsByRef)
        // cannot be encoded into a SignatureTypeEncoder slot. Callers must arrange the
        // byref form via the parent encoder. Detect and fail loudly so the previously
        // silent miscoding shows up as an emit-time error.
        if (type != null && type.IsByRef)
        {
            throw new InvalidOperationException(
                $"Cannot encode CLR byref type '{type.FullName}' as a non-byref signature slot; "
                + "use the parent encoder's Type(isByRef: true) overload and pass the element type to EncodeClrType.");
        }

        // ADR-0122 / issue #1014: a CLR unmanaged pointer (`T*`, Type.IsPointer)
        // encodes with the `*` element-type prefix followed by the element type.
        if (type != null && type.IsPointer)
        {
            EncodeClrType(encoder.Pointer(), type.GetElementType()!);
            return;
        }

        // Compare by FullName so types from a MetadataLoadContext (carrying the target
        // framework's identity) still encode to the same well-known primitive opcodes.
        var fullName = type?.FullName;
        switch (fullName)
        {
            case "System.Boolean":
                encoder.Boolean();
                break;
            case "System.Byte":
                encoder.Byte();
                break;
            case "System.SByte":
                encoder.SByte();
                break;
            case "System.Int16":
                encoder.Int16();
                break;
            case "System.UInt16":
                encoder.UInt16();
                break;
            case "System.Int32":
                encoder.Int32();
                break;
            case "System.UInt32":
                encoder.UInt32();
                break;
            case "System.Int64":
                encoder.Int64();
                break;
            case "System.UInt64":
                encoder.UInt64();
                break;
            case "System.Single":
                encoder.Single();
                break;
            case "System.Double":
                encoder.Double();
                break;
            case "System.Char":
                encoder.Char();
                break;
            case "System.String":
                encoder.String();
                break;
            case "System.Object":
                encoder.Object();
                break;
            case "System.IntPtr":
                encoder.IntPtr();
                break;
            case "System.UIntPtr":
                encoder.UIntPtr();
                break;
            case "System.Void":
                // ADR-0124 / issue #1024: `void*` (the first parameter of
                // `Span<T>(void* pointer, int length)`) encodes as PTR VOID.
                // The pointer prefix is written by the parent `encoder.Pointer()`
                // call (see the IsPointer branch above); here we emit the raw
                // ELEMENT_TYPE_VOID for the pointee. SignatureTypeEncoder has no
                // Void() helper (void is only valid as a return or pointee), so
                // write the type-code byte directly.
                encoder.Builder.WriteByte((byte)System.Reflection.Metadata.SignatureTypeCode.Void);
                break;
            default:
                if (type == null)
                {
                    throw new NotSupportedException("Cannot encode signature for a null CLR type.");
                }

                if (type.IsGenericParameter)
                {
                    // Method signatures reference declaring-type generic params as `!N`
                    // and declaring-method generic params as `!!N` (Phase E adds method
                    // generic support for calls like `Channel.CreateUnbounded<T>()`).
                    if (type.DeclaringMethod != null)
                    {
                        encoder.GenericMethodTypeParameter(type.GenericParameterPosition);
                    }
                    else
                    {
                        encoder.GenericTypeParameter(type.GenericParameterPosition);
                    }

                    break;
                }

                if (type.IsArray && type.GetArrayRank() == 1)
                {
                    EncodeClrType(encoder.SZArray(), type.GetElementType()!);
                    break;
                }

                if (type.IsConstructedGenericType)
                {
                    var openDef = type.GetGenericTypeDefinition();
                    var typeArgs = type.GetGenericArguments();
                    var genericInst = encoder.GenericInstantiation(
                        this.outer.memberRefs.GetTypeReference(openDef),
                        typeArgs.Length,
                        isValueType: openDef.IsValueType);
                    foreach (var arg in typeArgs)
                    {
                        EncodeClrType(genericInst.AddArgument(), arg);
                    }

                    break;
                }

                // A generic type definition used as a return/parameter type in an
                // open method signature (e.g. AsyncTaskMethodBuilder<TResult>.Create()
                // returning AsyncTaskMethodBuilder<TResult>). The reflection type is
                // the generic type definition itself, but it must encode as a
                // GenericInstantiation with its own type parameters as arguments.
                if (type.IsGenericTypeDefinition)
                {
                    var typeParams = type.GetGenericArguments();
                    var genericInst = encoder.GenericInstantiation(
                        this.outer.memberRefs.GetTypeReference(type),
                        typeParams.Length,
                        isValueType: type.IsValueType);
                    foreach (var tp in typeParams)
                    {
                        EncodeClrType(genericInst.AddArgument(), tp);
                    }

                    break;
                }

                encoder.Type(this.outer.memberRefs.GetTypeReference(type), isValueType: type.IsValueType);
                break;
        }
    }

    internal void EncodeReturnClr(ReturnTypeEncoder encoder, ParameterInfo returnParameter, Type type)
    {
        if (type?.FullName == "System.Void")
        {
            // Issue #522: a void return may still carry required custom
            // modifiers — most notably C# 9 init-only property setters emit
            // `modreq(System.Runtime.CompilerServices.IsExternalInit)` on the
            // setter's void return. The modreq is part of the method
            // signature; if we omit it the MemberRef fails to resolve at
            // runtime (System.MissingMethodException). Mirrors the byref
            // branch below — encode modreqs first, then the void slot.
            var voidRequiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes;
            if (voidRequiredModifiers.Length > 0)
            {
                var modifiers = encoder.CustomModifiers();
                foreach (var modifier in voidRequiredModifiers)
                {
                    modifiers.AddModifier(this.outer.memberRefs.GetTypeReference(modifier), isOptional: false);
                }
            }

            encoder.Void();
        }
        else if (type != null && type.IsByRef)
        {
            // ADR-0056 §1/§2: a `ref`/`ref readonly T` return (e.g. the span
            // indexer's `get_Item`) must encode as a managed pointer to the
            // pointee. A `ref readonly T` return additionally carries a required
            // custom modifier (`modreq(InAttribute)` on `ReadOnlySpan[T]`); it
            // must be encoded or the methodref signature fails to resolve at
            // runtime (MissingMethodException). Without `isByRef: true` the
            // return was malformed for every ref-returning member.
            var requiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes;
            if (requiredModifiers.Length > 0)
            {
                var modifiers = encoder.CustomModifiers();
                foreach (var modifier in requiredModifiers)
                {
                    modifiers.AddModifier(this.outer.memberRefs.GetTypeReference(modifier), isOptional: false);
                }
            }

            this.EncodeClrType(encoder.Type(isByRef: true), type.GetElementType()!);
        }
        else
        {
            this.EncodeClrType(encoder.Type(), type);
        }
    }

    /// <summary>
    /// Issue #295: map an arbitrary CLR delegate type (named or generic, e.g.
    /// <c>System.Predicate&lt;int&gt;</c>, <c>RequestDelegate</c>,
    /// <c>System.EventHandler</c>) from the host runtime onto the emitter's
    /// reference (MetadataLoadContext) types, reconstructing constructed
    /// generics from a reference open definition so the produced TypeSpec /
    /// MemberRef binds to the target framework assemblies. Falls back to the
    /// host type when no reference mapping is available.
    ///
    /// Issue #2325: this used to carry its own constructed-generic remapping
    /// loop, separate from (and ahead of) the one in
    /// <see cref="MapToReferenceClrType"/> — which only did a flat
    /// full-name lookup and therefore could not resolve a constructed generic
    /// argument (e.g. the inner `Action&lt;object&gt;` of
    /// `Action&lt;Action&lt;object&gt;, object&gt;`). That let a nested/
    /// higher-order delegate mix a MetadataLoadContext open definition with a
    /// host-context type argument, which `MakeGenericType` rejects at emit
    /// time (GS9998). `MapToReferenceClrType` now performs the same recursive
    /// remapping itself, so both callers share one implementation.
    /// </summary>
    internal Type ResolveTargetDelegateClrType(Type hostDelegate)
        => this.MapToReferenceClrType(hostDelegate);

    // Phase 4 emit parity (E1): resolve the BCL delegate type backing a
    // GSharp function type. The default ClrType on FunctionTypeSymbol uses
    // host-runtime `typeof(Func<,>)` (which lives in System.Private.CoreLib);
    // the emitter must instead reference the *target* framework's
    // System.Func / System.Action so the produced TypeRef binds to the right
    // assembly. Type arguments are resolved through references too so
    // signature encoding stays consistent end-to-end.
    internal Type ResolveDelegateClrType(FunctionTypeSymbol fnType)
    {
        bool isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType);
        int arity = fnType.ParameterTypes.Length;

        if (isVoid && arity == 0)
        {
            return this.emitCtx.References.GetCoreType("System.Action");
        }

        var typeName = isVoid
            ? "System.Action`" + arity.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.emitCtx.References.GetCoreType(typeName);

        var args = new Type[arity + (isVoid ? 0 : 1)];
        for (int i = 0; i < arity; i++)
        {
            args[i] = this.ResolveDelegateArgClrType(fnType.ParameterTypes[i]);
        }

        if (!isVoid)
        {
            args[arity] = this.ResolveDelegateArgClrType(fnType.ReturnType);
        }

        return openDef.MakeGenericType(args);
    }

    // Resolve the CLR type used as a System.Func/System.Action type argument
    // for one delegate parameter or return TypeSymbol. ADR-0087 §3 R6: under
    // the reified model, a type-parameter slot must not appear here — the
    // signature encoder takes the symbolic path
    // (<see cref="EncodeFunctionTypeSymbol"/>) and the body emitter routes
    // delegate ctor / Invoke through MemberRefs parented at the reified
    // TypeSpec. Any caller that still passes a type-parameter-bearing type
    // is a missed conversion site and worth surfacing.
    private Type ResolveDelegateArgClrType(TypeSymbol type)
    {
        // Issue #1518: a nullable value-type slot (T?) must materialise as
        // Nullable<T> on the delegate shape, not the bare underlying T. The
        // symbol's ClrType is the bare underlying, so lift through
        // NullableLifting.GetEffectiveClrType (identity for everything else)
        // to keep the emitted Func/Action delegate in agreement with the
        // instantiation overload-resolution inferred.
        return this.MapToReferenceClrType(NullableLifting.GetEffectiveClrType(type)) ?? this.emitCtx.CoreObjectType;
    }

    /// <summary>
    /// ADR-0087 §3 R6: encodes a <see cref="FunctionTypeSymbol"/> whose
    /// shape carries type-parameter slots (e.g. <c>func(T) U</c>) as a
    /// reified <c>GENERICINST&lt;Func`N or Action`N&gt;&lt;args&gt;</c>
    /// blob. Each argument is encoded recursively through
    /// <see cref="EncodeTypeSymbol"/>, so type parameters resolve to the
    /// proper <c>Var(idx)</c> / <c>MVar(idx)</c> slots.
    /// </summary>
    internal void EncodeFunctionTypeSymbol(SignatureTypeEncoder encoder, FunctionTypeSymbol fnType)
    {
        bool isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType);
        int arity = fnType.ParameterTypes.Length;

        if (isVoid && arity == 0)
        {
            var actionType = this.emitCtx.References.GetCoreType("System.Action");
            this.EncodeClrType(encoder, actionType);
            return;
        }

        var typeName = isVoid
            ? "System.Action`" + arity.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.emitCtx.References.GetCoreType(typeName);
        var openHandle = this.outer.memberRefs.GetTypeReference(openDef);
        int typeArgCount = arity + (isVoid ? 0 : 1);
        var gi = encoder.GenericInstantiation(openHandle, typeArgCount, isValueType: openDef.IsValueType);
        for (int i = 0; i < arity; i++)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), fnType.ParameterTypes[i]);
        }

        if (!isVoid)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), fnType.ReturnType);
        }
    }

    /// <summary>
    /// For an async lambda, resolves the delegate CLR type with the return type
    /// wrapped in Task/Task&lt;T&gt; (matching the actual kickoff method signature).
    /// </summary>
    internal Type ResolveAsyncDelegateClrType(FunctionTypeSymbol fnType, FunctionSymbol function)
    {
        // Find the async plan for this function.
        AsyncStateMachinePlan plan = null;
        foreach (var p in this.outer.stateMachines.AsyncStateMachinePlans)
        {
            if (p.KickoffMethod == function)
            {
                plan = p;
                break;
            }
        }

        if (plan == null)
        {
            return this.ResolveDelegateClrType(fnType);
        }

        var builderInfo = plan.StateMachine.BuilderInfo;
        Type taskClrType;
        if (builderInfo.Kind == AsyncMethodBuilderKind.Void)
        {
            taskClrType = typeof(System.Threading.Tasks.Task);
        }
        else if (builderInfo.TaskProperty != null)
        {
            taskClrType = builderInfo.TaskProperty.PropertyType;
        }
        else
        {
            taskClrType = typeof(System.Threading.Tasks.Task);
        }

        int arity = fnType.ParameterTypes.Length;
        var typeName = "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.emitCtx.References.GetCoreType(typeName);

        var args = new Type[arity + 1];
        for (int i = 0; i < arity; i++)
        {
            args[i] = this.MapToReferenceClrType(fnType.ParameterTypes[i].ClrType);
        }

        args[arity] = this.MapToReferenceClrType(taskClrType);
        return openDef.MakeGenericType(args);
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
    internal Type MapToReferenceClrType(Type hostType)
    {
        if (hostType == null)
        {
            return null;
        }

        if (hostType.IsByRef)
        {
            var mappedElement = this.MapToReferenceClrType(hostType.GetElementType()) ?? hostType.GetElementType();
            return mappedElement.MakeByRefType();
        }

        if (hostType.IsPointer)
        {
            var mappedElement = this.MapToReferenceClrType(hostType.GetElementType()) ?? hostType.GetElementType();
            return mappedElement.MakePointerType();
        }

        if (hostType.IsArray)
        {
            var mappedElement = this.MapToReferenceClrType(hostType.GetElementType()) ?? hostType.GetElementType();

            // A rank-1 array is either a vector (`T[]`, constructed via the
            // parameterless `MakeArrayType()`) or a general rank-1 array
            // (`T[*]`, constructed via `MakeArrayType(1)`) — reflection
            // treats these as distinct array kinds sharing rank 1;
            // `Type.IsSZArray` is the documented way to tell them apart
            // (mirrors DocumentationIdProvider.AppendArraySuffix).
            return hostType.IsSZArray
                ? mappedElement.MakeArrayType()
                : mappedElement.MakeArrayType(hostType.GetArrayRank());
        }

        if (hostType.IsConstructedGenericType)
        {
            var openDef = hostType.GetGenericTypeDefinition();
            if (openDef.FullName != null
                && this.emitCtx.References.TryResolveType(openDef.FullName, requireExternalVisibility: false, out var openRef))
            {
                var hostArgs = hostType.GetGenericArguments();
                var refArgs = new Type[hostArgs.Length];
                for (var i = 0; i < hostArgs.Length; i++)
                {
                    refArgs[i] = this.MapToReferenceClrType(hostArgs[i]) ?? hostArgs[i];
                }

                return openRef.MakeGenericType(refArgs);
            }

            return hostType;
        }

        if (this.emitCtx.References.TryResolveType(hostType.FullName ?? hostType.Name, requireExternalVisibility: false, out var mapped))
        {
            return mapped;
        }

        return hostType;
    }
}
