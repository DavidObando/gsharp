// <copyright file="ReflectionMetadataEmitter.Types.3.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class (this file mixes private helper classes inline with methods)
#pragma warning disable SA1202 // 'internal' members should come before 'private' members (PR-E-5: IsValueTypeSymbol was widened to internal in-place for ConversionEmitter; ordering is restored once Phase 2 decomposition finishes)
#pragma warning disable SA1304 // non-private readonly field naming — PR-E-11 widened several emitter-internal fields to internal so the promoted MethodBodyEmitter can read them; ordering/casing restored after E-12 root thinning
#pragma warning disable SA1307 // field naming casing — same as SA1304
#pragma warning disable SA1401 // field should be private — same as SA1304
#pragma warning disable SA1611 // parameter documentation missing — PR-E-11 widened internal helpers used by MethodBodyEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Emits a managed PE for a <see cref="BoundProgram"/> using
/// <see cref="System.Reflection.Metadata"/> directly.
/// </summary>
/// <remarks>
/// Phase 2 (p2-langcov) coverage: locals, parameters, unary/binary operators,
/// assignments, label/goto/conditional-goto, user-defined function calls
/// (emitted as static methods on <c>&lt;Program&gt;</c>), and the imported-call
/// surface inherited from Phase 1. Per ADR-0027 the bespoke emitter is the
/// production path for v1.0; the Roslyn-fork escape valve referenced in
/// earlier comments here has been removed from the tree.
/// </remarks>

internal sealed partial class ReflectionMetadataEmitter
{


    private void EncodeTypeSymbol(SignatureTypeEncoder encoder, TypeSymbol type)
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
                    this.GetTypeReference(nullableOpen),
                    genericArgumentCount: 1,
                    isValueType: true);
                this.EncodeTypeSymbol(giNullable.AddArgument(), nullableTp);
                return;
            }

            if (inner is StructSymbol nestedStruct && !nestedStruct.IsClass)
            {
                throw new NotSupportedException(
                    $"Nullable user-defined struct '{inner.Name}?' is not yet supported by the emitter.");
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
                    this.GetTypeReference(nullableOpenForEnum),
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
            // Issue #810: when emitting a state-machine method (or the
            // state-machine class itself), references to the OUTER
            // method's type parameters are encoded as the SM class's
            // own type parameters (Var(i)). This mirrors how Roslyn
            // emits `<Empty>d__0<T>` where the body's `!!0` becomes
            // `!0` on the SM class. The remap is pushed by
            // EmitIteratorStateMachineMember and is keyed by the
            // method TP's instance identity.
            if (this.activeIteratorStateMachineRemap != null
                && tp.IsMethodTypeParameter
                && this.activeIteratorStateMachineRemap.TryGetValue(tp, out var classOrdinal))
            {
                encoder.GenericTypeParameter(classOrdinal);
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
        else if (type is ImportedTypeSymbol symbolicImported
            && !symbolicImported.TypeArguments.IsDefaultOrEmpty
            && !symbolicImported.HasTypeParameterArgument
            && symbolicImported.OpenDefinition != null
            && symbolicImported.TypeArguments.Any(ArgIsSymbolicUserDefined))
        {
            var genericInst = encoder.GenericInstantiation(
                this.GetTypeReference(symbolicImported.OpenDefinition),
                symbolicImported.TypeArguments.Length,
                isValueType: symbolicImported.OpenDefinition.IsValueType);
            foreach (var arg in symbolicImported.TypeArguments)
            {
                this.EncodeTypeSymbol(genericInst.AddArgument(), arg);
            }
        }
        else if (type is ImportedTypeSymbol erasedGeneric && erasedGeneric.HasTypeParameterArgument)
        {
            // ADR-0087 §3 R2: a generic CLR type constructed over an in-scope
            // type parameter (e.g. `List[T]`) is no longer erased to
            // `System.Object`. Emit a real `GENERICINST<def><args>` so the
            // signature carries `Var`/`MVar` slots that match the actual
            // runtime type. Boxing/unboxing at boundaries is now handled by
            // explicit `box T`/`unbox.any T` in the body emitter when the
            // value bridges across an `object` slot.
            var openDef = erasedGeneric.OpenDefinition
                ?? throw new InvalidOperationException(
                    $"Imported generic '{erasedGeneric.Name}' has no OpenDefinition for GENERICINST encoding.");
            var giOpen = encoder.GenericInstantiation(
                this.GetTypeReference(openDef),
                erasedGeneric.TypeArguments.Length,
                isValueType: openDef.IsValueType);
            foreach (var arg in erasedGeneric.TypeArguments)
            {
                this.EncodeTypeSymbol(giOpen.AddArgument(), arg);
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
                this.GetTypeReference(enumerableOpen),
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
                this.GetTypeReference(asyncEnumerableOpen),
                1,
                isValueType: false);
            this.EncodeTypeSymbol(giAseq.AddArgument(), openAseq.ElementType);
        }
        else if (type is StructSymbol structSym)
        {
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

            if (IsUserGenericTypeReference(structSym))
            {
                ImmutableArray<TypeSymbol> typeArgs;
                if (!structSym.TypeArguments.IsDefaultOrEmpty)
                {
                    typeArgs = structSym.TypeArguments;
                }
                else
                {
                    var defTps = defSym.TypeParameters;
                    var bld = ImmutableArray.CreateBuilder<TypeSymbol>(defTps.Length);
                    foreach (var defTp in defTps)
                    {
                        bld.Add(defTp);
                    }

                    typeArgs = bld.MoveToImmutable();
                }

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

            if (IsUserGenericInterfaceReference(ifaceSym))
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
            if (!this.cache.DelegateTypeDefs.TryGetValue(delegateSym, out var delegateDef))
            {
                throw new InvalidOperationException($"Delegate '{delegateSym.Name}' has no emitted TypeDef.");
            }

            encoder.Type(delegateDef, isValueType: false);
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
        else if (type is TupleTypeSymbol tupleWithNullClr && tupleWithNullClr.ClrType == null
            && tupleWithNullClr.Arity >= 2 && tupleWithNullClr.Arity <= 7)
        {
            // Issue #649: Tuple containing G#-defined types whose ClrType is null.
            // Encode as ValueTuple<...> generic instantiation using EncodeTypeSymbol
            // for each element so user-defined types reference their TypeDef handles.
            var openType = tupleWithNullClr.Arity switch
            {
                2 => typeof(ValueTuple<,>),
                3 => typeof(ValueTuple<,,>),
                4 => typeof(ValueTuple<,,,>),
                5 => typeof(ValueTuple<,,,,>),
                6 => typeof(ValueTuple<,,,,,>),
                7 => typeof(ValueTuple<,,,,,,>),
                _ => throw new NotSupportedException("unreachable"),
            };

            var genericInst = encoder.GenericInstantiation(
                this.GetTypeReference(openType),
                tupleWithNullClr.Arity,
                isValueType: true);
            foreach (var elemType in tupleWithNullClr.ElementTypes)
            {
                this.EncodeTypeSymbol(genericInst.AddArgument(), elemType);
            }
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
        else if (type?.ClrType != null)
        {
            this.EncodeClrType(encoder, type.ClrType);
        }
        else if (type is FunctionTypeSymbol openFn)
        {
            // ADR-0087 §3 R6: encode an open-bearing delegate type as a
            // reified `GENERICINST<Func`N or Action`N><args>` so the
            // signature carries `Var`/`MVar` slots that match the
            // runtime delegate. Previously the encoder fell back to
            // `Func<object, object>`, and the call site bridged the
            // value-type boundary through `Delegate.DynamicInvoke`.
            this.EncodeFunctionTypeSymbol(encoder, openFn);
        }
        else
        {
            throw new NotSupportedException($"Cannot encode signature for type '{type?.Name}' yet.");
        }
    }

    private static bool TryCreateSymbolicAsyncTaskType(SynthesizedStateMachineType stateMachine, out TypeSymbol taskType)
    {
        taskType = null;
        if (stateMachine?.ResultTypeSymbol == null
            || !IsAsyncUserDefinedResultType(stateMachine.ResultTypeSymbol)
            || stateMachine.BuilderInfo?.TaskProperty?.PropertyType is not Type taskClrType
            || !taskClrType.IsConstructedGenericType)
        {
            return false;
        }

        taskType = ImportedTypeSymbol.GetConstructed(
            taskClrType,
            taskClrType.GetGenericTypeDefinition(),
            ImmutableArray.Create(stateMachine.ResultTypeSymbol));
        return true;
    }

    // Phase 4 emit parity (F1): used by call sites to decide whether a value
    // crossing the open-generic boundary needs box / unbox.any. Mirrors the
    // CLR's value-type predicate over GSharp type symbols.
    // PR-E-5: widened from `private static` to `internal static` so the
    // extracted ConversionEmitter (a sibling file in this assembly) can
    // call into the canonical value-type test without taking a hard
    // back-reference to the root emitter. The predicate itself is
    // structurally pure and has no other dependencies.
    internal static bool IsValueTypeSymbol(TypeSymbol type)
    {
        if (type == TypeSymbol.Int32 || type == TypeSymbol.Bool)
        {
            return true;
        }

        if (type is StructSymbol s && !s.IsClass)
        {
            return true;
        }

        // Issue #193: a user-defined enum is a CLR value type (sealed,
        // derives from System.Enum). Boundary boxing logic (e.g. generic
        // argument passing) must treat it as such even though it has no
        // ClrType on the symbol.
        if (type is EnumSymbol)
        {
            return true;
        }

        // Issue #813: a tuple type is always a CLR value type
        // (`System.ValueTuple<...>`). When one or more of its element types
        // is an open generic parameter the symbol's ClrType is null and
        // the ClrType-based branch below misses it, so boxing decisions
        // (e.g. `(int32, T) → object`) on iterator yield paths would
        // throw GS9998 from the emitter's NotSupportedException. Recognise
        // the symbolic form directly.
        if (type is TupleTypeSymbol)
        {
            return true;
        }

        // Issue #806: a `T?` over a value-type-constrained type parameter
        // lowers to `Nullable<T>` (a struct). Without recognising this
        // symbolic form, instance-method calls on the receiver would emit
        // `callvirt` + value-on-stack instead of `call` + managed pointer,
        // producing PEVerify-rejected IL.
        if (type is NullableTypeSymbol nullableTp
            && nullableTp.UnderlyingType is TypeParameterSymbol tp
            && tp.HasValueTypeConstraint)
        {
            return true;
        }

        // Issue #1298: `E?` over a user-declared enum lowers to the CLR struct
        // `System.Nullable<E>`. The enum has no ClrType on the symbol, so the
        // ClrType-based branch below misses it; recognise the symbolic form so
        // default-init (`ldloca; initobj; ldloc`) and boxing decisions treat it
        // as a value type.
        if (type is NullableTypeSymbol nullableEnum
            && nullableEnum.UnderlyingType is EnumSymbol)
        {
            return true;
        }

        if (type?.ClrType != null && type.ClrType.IsValueType)
        {
            return true;
        }

        return false;
    }

    // Issue #504: a NullableTypeSymbol whose underlying CLR type is a value
    // type maps to the CLR struct `System.Nullable<T>` — a distinct CLR
    // value type with its own layout and ctor. NullableTypeSymbol over a
    // reference type, by contrast, shares the CLR representation of T (the
    // wrapper is a binder-level annotation; ldnull is a valid value for it).
    // Emit-time conversion logic for value-type Nullable<T> needs a
    // `newobj Nullable<T>::.ctor(T)` for the lift, an `initobj` for the
    // default value, and `box Nullable<T>` for object widening — none of
    // which the reference-type path handles.
    internal static bool IsValueTypeNullable(NullableTypeSymbol nullable)
        => NullableLifting.IsValueTypeNullable(nullable);

    private void EncodeClrType(SignatureTypeEncoder encoder, Type type)
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
                        this.GetTypeReference(openDef),
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
                        this.GetTypeReference(type),
                        typeParams.Length,
                        isValueType: type.IsValueType);
                    foreach (var tp in typeParams)
                    {
                        EncodeClrType(genericInst.AddArgument(), tp);
                    }

                    break;
                }

                encoder.Type(this.GetTypeReference(type), isValueType: type.IsValueType);
                break;
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
    /// </summary>
    internal Type ResolveTargetDelegateClrType(Type hostDelegate)
    {
        if (hostDelegate == null)
        {
            return null;
        }

        if (hostDelegate.IsConstructedGenericType)
        {
            var openName = hostDelegate.GetGenericTypeDefinition().FullName;
            if (openName != null && this.emitCtx.References.TryResolveType(openName, out var openRef))
            {
                var hostArgs = hostDelegate.GetGenericArguments();
                var refArgs = new Type[hostArgs.Length];
                for (var i = 0; i < hostArgs.Length; i++)
                {
                    refArgs[i] = this.MapToReferenceClrType(hostArgs[i]) ?? hostArgs[i];
                }

                return openRef.MakeGenericType(refArgs);
            }

            return hostDelegate;
        }

        return this.MapToReferenceClrType(hostDelegate) ?? hostDelegate;
    }

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
        return this.MapToReferenceClrType(type.ClrType) ?? this.emitCtx.CoreObjectType;
    }

    // ADR-0087 §3 R6: cache for reified delegate (Func/Action) TypeSpecs
    // keyed by a stable function-type symbol identity. A FunctionTypeSymbol
    // is cached by its parameter/return symbol identities (see
    // FunctionTypeSymbol.Get) so reference-equality is sufficient.
    private readonly Dictionary<FunctionTypeSymbol, EntityHandle> functionDelegateTypeSpecCache =
        new Dictionary<FunctionTypeSymbol, EntityHandle>(ReferenceEqualityComparer.Instance);

    /// <summary>
    /// For an async lambda, resolves the delegate CLR type with the return type
    /// wrapped in Task/Task&lt;T&gt; (matching the actual kickoff method signature).
    /// </summary>
    internal Type ResolveAsyncDelegateClrType(FunctionTypeSymbol fnType, FunctionSymbol function)
    {
        // Find the async plan for this function.
        AsyncStateMachinePlan plan = null;
        foreach (var p in this.stateMachines.AsyncStateMachinePlans)
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
}
