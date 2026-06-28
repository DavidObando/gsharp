// <copyright file="ReflectionMetadataEmitter.Types.cs" company="GSharp">
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


    // PR-E-9: closure-environment metadata and synthesized display classes
    // moved onto ClosureEmitter. Where this file used to declare:
    //   closureInfos                  -> closures.ClosureInfos
    //   goClosureInfos                -> closures.GoClosureInfos
    //   synthesizedClosureClasses     -> closures.SynthesizedClosureClasses
    //   closureInvokeToInfo           -> closures.ClosureInvokeToInfo
    //   closureCounter                -> closures.Counter
    // The state-machine synthesizers below moved onto StateMachineEmitter in
    // PR-E-10; this file still mutates closures.SynthesizedClosureClasses and
    // closures.Counter from inside StateMachineEmitter via the closures
    // back-reference.

    // PR-E-10: state-machine caches and plans moved onto StateMachineEmitter.
    // Where this file used to declare:
    //   iteratorKickoffBodies         -> stateMachines.IteratorKickoffBodies
    //   iteratorStateMachineInfos     -> stateMachines.IteratorStateMachineInfos
    //   asyncStateMachinePlans        -> stateMachines.AsyncStateMachinePlans
    //   iteratorPlans                 -> stateMachines.IteratorPlans
    //   asyncIteratorPlans            -> stateMachines.AsyncIteratorPlans
    //   asyncIteratorInfos            -> stateMachines.AsyncIteratorInfos
    //   asyncIteratorEmitContexts     -> stateMachines.AsyncIteratorEmitContexts
    //   asyncSmEnclosingClosures      -> stateMachines.AsyncSmEnclosingClosures
    // BodyEmitter reads stateMachines.AsyncIteratorEmitContexts for the async
    // iterator MoveNext path; the remaining 2 BodyEmitter-internal SM helpers
    // (EmitStateMachineAwaitOnCompleted, EmitAsyncIteratorBuilderMoveNext)
    // still live inside BodyEmitter and call back into
    // stateMachines.EmitAwaitOnCompletedCall — they move with BodyEmitter in
    // PR-E-11 MethodBodyEmitter.

    // PR-E-1: debugInformation, pdbStream, pdb moved onto EmitContext.

    // PR-E-1: the BCL core* Type fields (coreObjectType, coreStringType,
    // coreInt32Type, coreBooleanType, coreArrayType, coreValueType,
    // coreSystemType, coreRuntimeTypeHandleType, coreEnumType,
    // coreMulticastDelegateType, coreIntPtrType) moved onto EmitContext.
    // PR-E-3: objectTypeRef, valueTypeRef, objectCtorRef,
    // stringConcatRef/EqualsRef, objectStaticEqualsRef,
    // objectInstanceToStringRef/GetHashCodeRef, nullRefExceptionCtorRef,
    // stringConcatArrayRef, convertToStringRef, cultureInvariantGetterRef,
    // hashCodeAddOpenRef/ToHashCodeRef, hashCodeCombineOpenRefs[],
    // hashCodeTypeRef, systemAttributeTypeRef/CtorRef moved onto
    // WellKnownReferences.
    // PR-E-6: hashCodeLocalSig moved onto DataStructSynthesizer alongside
    // its sole user (GetHashCodeLocalSignature).

    // PR-E-4: SlotPlanner owns the slot-allocator BoundTreeWalker collectors
    // (16 of them) and the SelectSlots value object they populate. The slot
    // dictionaries themselves remain per-method-emit and stay on BodyEmitter /
    // are passed into SlotPlanner entry points as arguments; SlotPlanner does
    // not depend on this emitter — it takes its two RME-flavored dependencies
    // (the MetadataTokenCache for GlobalFieldDefs lookups, and the
    // NeedsRvalueReceiverSpill predicate) via constructor injection.
    // PR-E-11: widened to internal so the promoted MethodBodyEmitter can read it.
    internal readonly SlotPlanner slotPlanner;

    // Issue #810: when emitting a member of a generic iterator state-machine
    // class (the SM's own field-defs, MoveNext body, get_Current signature,
    // interface impls, etc.), the body and signatures still reference the
    // OUTER method's `TypeParameterSymbol` instances (which carry
    // `IsMethodTypeParameter=true`). The state-machine class is itself
    // generic over class-level type parameters (Var(0..N-1)) that mirror the
    // outer method's TPs. EncodeTypeSymbol consults this remap to translate
    // each outer-method TP reference into a `Var(classOrdinal)` slot. The
    // remap is pushed by StateMachineEmitter around each SM-member emit
    // boundary (TypeDef, FieldDefs, interface impls, MethodDefs) and popped
    // afterward, so non-SM code paths see the normal Var/MVar discrimination.
    internal Dictionary<TypeParameterSymbol, int> activeIteratorStateMachineRemap;

    /// <summary>
    /// Issue #191: emits one static <c>FieldDef</c> per user-declared top-level
    /// <c>var</c>/<c>let</c>/<c>const</c> on the entry-point package's
    /// <c>&lt;Program&gt;</c> TypeDef. Initialization stays in the entry-point
    /// method body and runs via <c>stsfld</c> as each declaration is reached,
    /// preserving existing side-effect ordering (e.g. a top-level
    /// <c>let ch = make(chan int)</c> followed by sends/receives).
    /// </summary>
    /// <remarks>
    /// The <c>InitOnly</c> flag is intentionally omitted for <c>let</c>/<c>const</c>
    /// globals: enforcing it would require moving initialization into a
    /// <c>.cctor</c>, which would reorder execution relative to interleaved
    /// top-level statements. Tracking InitOnly is left as a #191 follow-up.
    /// </remarks>
    private void EmitGlobalFieldDefs(ImmutableArray<GlobalVariableSymbol> globals)
    {
        foreach (var g in globals)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), g.Type);

            var attrs = AccessibilityMap.MapFieldAccessibility(g.Accessibility) | FieldAttributes.Static;

            var handle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: attrs,
                name: this.emitCtx.Metadata.GetOrAddString(g.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));

            this.cache.GlobalFieldDefs[g] = handle;

            // Route any @-annotations bound by #187 onto the FieldDef row so
            // attributes like @Obsolete round-trip into CustomAttribute rows.
            this.customAttrEncoder.EmitUserAttributes(handle, g, AttributeTargetKind.Field);
        }
    }

    // PR-E-5: EmitDefaultValue(InstructionEncoder, Type) moved to
    // ConversionEmitter. The pre-refactor source had no callers for this
    // helper — it sits in the conversion-shaped emit surface alongside
    // EmitBoxIfNeeded and is preserved for parity / future use.

    /// <summary>
    /// Encodes the CLR return type for an async kickoff method:
    /// <c>Task</c>, <c>Task&lt;T&gt;</c>, or <c>void</c> for async-void.
    /// </summary>
    private void EncodeAsyncReturnType(ReturnTypeEncoder encoder, AsyncStateMachinePlan plan)
    {
        var builderInfo = plan.StateMachine.BuilderInfo;
        if (builderInfo.Kind == AsyncMethodBuilderKind.Void)
        {
            encoder.Void();
        }
        else if (builderInfo.TaskProperty != null)
        {
            if (TryCreateSymbolicAsyncTaskType(plan.StateMachine, out var symbolicTaskType))
            {
                this.EncodeTypeSymbol(encoder.Type(), symbolicTaskType);
            }
            else
            {
                // The Task property's return type IS the kickoff return type.
                var taskClrType = builderInfo.TaskProperty.PropertyType;
                this.EncodeClrType(encoder.Type(), taskClrType);
            }
        }
        else
        {
            encoder.Void();
        }
    }

    /// <summary>
    /// Issue #640: builds the bound assignment statements for all instance
    /// field initializers in declaration order. Used by the default, primary,
    /// forwarding, and explicit constructor body emitters.
    /// </summary>
    private static ImmutableArray<BoundStatement> BuildInstanceFieldInitializerStatements(StructSymbol classSym, ParameterSymbol thisParam = null)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var field in classSym.Fields)
        {
            if (classSym.InstanceFieldInitializers.TryGetValue(field, out var initExpr))
            {
                var assignment = new BoundFieldAssignmentExpression(null, thisParam, classSym, field, initExpr);
                statements.Add(new BoundExpressionStatement(null, assignment));
            }
        }

        return statements.ToImmutable();
    }

    /// <summary>
    /// ADR-0096 / issue #762: writes a CLR <c>FieldMarshal</c> table
    /// row keyed off <paramref name="paramHandle"/> carrying the
    /// per-parameter marshalling descriptor blob encoded per ECMA-335
    /// II.23.4. The corresponding <see cref="ParameterAttributes.HasFieldMarshal"/>
    /// bit must be set on the Param row by the caller (the runtime uses
    /// the bit to decide whether to read this table).
    /// </summary>
    /// <param name="paramHandle">The owning Parameter row handle.</param>
    /// <param name="metadata">The resolved per-parameter <c>@MarshalAs</c> metadata.</param>
    private void EmitFieldMarshalRow(ParameterHandle paramHandle, MarshalAsMetadata metadata)
    {
        var blobBuilder = new BlobBuilder();
        blobBuilder.WriteBytes(metadata.EncodeFieldMarshalBlob());
        this.emitCtx.Metadata.AddMarshallingDescriptor(
            paramHandle,
            this.emitCtx.Metadata.GetOrAddBlob(blobBuilder));
    }

    private bool IsAddressableFieldAccessForReceiverSpill(
        BoundFieldAccessExpression fa,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        if (fa.Receiver == null)
        {
            return true;
        }

        if (fa.Receiver.Type is StructSymbol rs && rs.IsClass)
        {
            return true;
        }

        if (fa.Receiver.Type?.ClrType != null && !fa.Receiver.Type.ClrType.IsValueType)
        {
            return true;
        }

        if (fa.Receiver is BoundVariableExpression bv
            && this.CanLoadVariableAddressForReceiverSpill(bv.Variable, function, locals))
        {
            return true;
        }

        if (fa.Receiver is BoundFieldAccessExpression nested
            && this.cache.StructFieldDefs.ContainsKey(nested.Field))
        {
            return this.IsAddressableFieldAccessForReceiverSpill(nested, function, locals);
        }

        return false;
    }

    internal EntityHandle GetElementTypeToken(TypeSymbol element)
    {
        // P2-7 / Issue #421: nullable over a value type tokenises as
        // System.Nullable<T>. NullableTypeSymbol over a reference type
        // continues to share the underlying CLR type (handled below by
        // the `element.ClrType != null` branch via the NullableTypeSymbol
        // ctor that copies `underlying.ClrType`).
        if (element is NullableTypeSymbol nullableElement
            && nullableElement.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerClr)
        {
            // Issue #571: route Nullable<T> through the ReferenceResolver so the
            // open definition and the (possibly MLC-backed) inner come from the
            // same load context. The host `typeof(System.Nullable<>)` mixes
            // contexts and trips GS9998 inside the TypeBuilder/MetadataBuilder
            // ctor/member-reference paths.
            if (!NullableLifting.TryConstructNullable(this.emitCtx.References, nullableInnerClr, out var nullableClr))
            {
                throw new InvalidOperationException(
                    $"Cannot construct Nullable<{nullableInnerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
            }

            return this.GetTypeHandleForMember(nullableClr);
        }

        // Issue #814 / ADR-0084 §L5: `T?` over an open type parameter.
        // For `[T struct]` the storage shape is `Nullable<!!T>`, encoded
        // as a TypeSpec naming the generic instantiation; this is the
        // token consumed by `initobj` when zero-initialising the slot.
        // For `[T class]` the storage shape is the bare `!!T` (a reference
        // slot that holds `null`), so we forward to the existing
        // TypeParameterSymbol branch by recursing on the underlying.
        if (element is NullableTypeSymbol nullableTpElement
            && nullableTpElement.UnderlyingType is TypeParameterSymbol nullableTpInner)
        {
            if (nullableTpInner.HasValueTypeConstraint)
            {
                var sigBlob = new BlobBuilder();
                this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), nullableTpElement);
                return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            }

            return this.GetElementTypeToken(nullableTpInner);
        }

        // Issue #1298: `E?` over a user-declared enum tokenises as a TypeSpec
        // naming the generic instantiation `System.Nullable<E>`. This is the
        // token consumed by `box Nullable<E>` in the lifted enum-equality emit
        // (and by `initobj` when zero-initialising such a slot).
        if (element is NullableTypeSymbol nullableEnumElement
            && nullableEnumElement.UnderlyingType is EnumSymbol)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), nullableEnumElement);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element == TypeSymbol.Int32)
        {
            return this.GetTypeReference(this.emitCtx.CoreInt32Type);
        }

        if (element == TypeSymbol.Bool)
        {
            return this.GetTypeReference(this.emitCtx.CoreBooleanType);
        }

        if (element == TypeSymbol.String)
        {
            return this.GetTypeReference(this.emitCtx.CoreStringType);
        }

        if (element is ArrayTypeSymbol nestedArr)
        {
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeTypeSymbol(encoder, nestedArr);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is SliceTypeSymbol nestedSlice)
        {
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeTypeSymbol(encoder, nestedSlice);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is ImportedTypeSymbol symbolicImported
            && !symbolicImported.TypeArguments.IsDefaultOrEmpty
            && !symbolicImported.HasTypeParameterArgument
            && symbolicImported.TypeArguments.Any(ArgIsSymbolicUserDefined))
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), symbolicImported);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        // Issue #813: a tuple whose element types include an open generic
        // (TupleTypeSymbol.ClrType == null) needs a symbolic TypeSpec
        // built via the shared helper; the encoder threads each element
        // through EncodeTypeSymbol so the active iterator-state-machine
        // remap (issue #810) translates outer-method TPs to the SM
        // class's own type parameters. Without this branch, boxing a
        // `(int32, T)` to `object` from inside a state-machine method
        // body throws GS9998 from the EnumSymbol/throw tail below.
        if (element is TupleTypeSymbol symbolicTuple
            && symbolicTuple.ClrType == null
            && symbolicTuple.Arity >= 2
            && symbolicTuple.Arity <= 7)
        {
            return this.GetTupleTypeSpec(symbolicTuple);
        }

        // ADR-0087 §3 R3: an ImportedTypeSymbol whose generic args mention a
        // type parameter (e.g. `Dictionary<string, T>` where T is MVAR(0))
        // must tokenise as a TypeSpec carrying VAR/MVAR, not the erased
        // closed `ClrType` (which encodes T as `object`). Otherwise tokens
        // like `unbox.any Dictionary<string,T>` widen to the wrong shape.
        if (element is ImportedTypeSymbol tpImported && tpImported.HasTypeParameterArgument)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), tpImported);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is FunctionTypeSymbol fnElement && fnElement.ClrType == null)
        {
            // ADR-0087 §3 R6: an open-bearing function type
            // (e.g. `(T) -> U`) tokenises as a TypeSpec for the
            // reified `Func<...>` / `Action<...>` shape, with VAR/MVAR
            // slots that the runtime substitutes against the
            // surrounding generic instantiation.
            return this.GetFunctionDelegateTypeSpec(fnElement);
        }

        if (element.ClrType != null)
        {
            if (element.ClrType.IsConstructedGenericType)
            {
                return this.GetTypeHandleForMember(element.ClrType);
            }

            return this.GetTypeReference(element.ClrType);
        }

        if (element is StructSymbol structSym)
        {
            // ADR-0087 §3 R3: a constructed user-generic struct must
            // tokenise as a TypeSpec, not the bare TypeDef row.
            if (IsUserGenericTypeReference(structSym))
            {
                return this.GetUserStructTypeSpec(structSym);
            }

            if (this.cache.StructTypeDefs.TryGetValue(structSym, out var td))
            {
                return td;
            }
        }

        if (element is TypeParameterSymbol tpSym)
        {
            // ADR-0087 §3 R3: a type-parameter element token (e.g. for
            // `stobj T` against a `&T` parameter, or `initobj T` for a
            // default value) encodes as a TypeSpec naming VAR(idx) /
            // MVAR(idx).
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();

            // Issue #810: inside an iterator state-machine method body,
            // outer-method TPs are remapped to the SM class's own TPs.
            if (this.activeIteratorStateMachineRemap != null
                && tpSym.IsMethodTypeParameter
                && this.activeIteratorStateMachineRemap.TryGetValue(tpSym, out var smClassOrd))
            {
                encoder.GenericTypeParameter(smClassOrd);
            }
            else if (tpSym.IsMethodTypeParameter)
            {
                encoder.GenericMethodTypeParameter(tpSym.Ordinal);
            }
            else
            {
                encoder.GenericTypeParameter(tpSym.Ordinal);
            }

            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is EnumSymbol enumSym && this.cache.EnumTypeDefs.TryGetValue(enumSym, out var etd))
        {
            return etd;
        }

        // Issue #1052: a user-declared interface used as a generic-parameter
        // constraint tokenises to its emitted TypeDef (non-generic) or a
        // TypeSpec naming the constructed instantiation (generic, e.g. the
        // self-referential `[T IFace[T]]`). This feeds the
        // GenericParamConstraint metadata row so the assembly verifies.
        if (element is InterfaceSymbol ifaceSym)
        {
            if (IsUserGenericInterfaceReference(ifaceSym))
            {
                var sigBlob = new BlobBuilder();
                this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), ifaceSym);
                return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            }

            var ifaceDef = ifaceSym.Definition ?? ifaceSym;
            if (this.cache.InterfaceTypeDefs.TryGetValue(ifaceDef, out var itd))
            {
                return itd;
            }
        }

        throw new NotSupportedException($"Cannot resolve element type token for '{element.Name}'.");
    }

    private Type ResolveCoreType(string fullName, Type fallback)
    {
        if (this.emitCtx.References.TryResolveType(fullName, out var t))
        {
            return t;
        }

        return fallback;
    }

    internal EntityHandle GetTypeOfToken(TypeSymbol type)
    {
        // Issue #143: `typeof(T)` token resolution. `NullableTypeSymbol` over a
        // value type must surface as `System.Nullable<T>` to match C# semantics
        // (binder/evaluator collapse the wrapper to its underlying type for
        // every other purpose — ADR-0001).
        if (type is NullableTypeSymbol nullable
            && nullable.UnderlyingType.ClrType is { IsValueType: true } valueClr)
        {
            // Issue #571: see GetElementTypeToken for rationale.
            if (!NullableLifting.TryConstructNullable(this.emitCtx.References, valueClr, out var nullableType))
            {
                throw new InvalidOperationException(
                    $"Cannot construct Nullable<{valueClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
            }

            return this.GetTypeHandleForMember(nullableType);
        }

        return this.GetElementTypeToken(type);
    }

    /// <summary>
    /// Returns <c>true</c> if <paramref name="type"/> is a core base type from
    /// <c>System.Private.CoreLib</c> that is publicly exposed through
    /// <c>System.Runtime</c>. These types are used as base types in TypeDef
    /// rows and must reference the public facade so external consumers can
    /// resolve them.
    /// </summary>
    private static bool IsCoreLibBaseType(Type type)
    {
        if (!string.Equals(type.Assembly.GetName().Name, "System.Private.CoreLib", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var fullName = type.FullName;
        return fullName == "System.Object"
            || fullName == "System.ValueType"
            || fullName == "System.Enum"
            || fullName == "System.Attribute"
            || fullName == "System.MulticastDelegate"
            || fullName == "System.Delegate"
            // Issue #806: `Nullable<T>` and the `ValueTuple<…>` family
            // are public type-forwarded types. The host-process typeof
            // calls for these are scoped to System.Private.CoreLib; if
            // we emit the TypeRef directly to the implementation
            // assembly, C# consumers (which only reference the contract
            // assemblies under Microsoft.NETCore.App.Ref/.../net10.0)
            // fail with CS0012 "The type '…' is defined in an assembly
            // that is not referenced". Route through System.Runtime,
            // which carries the type forwarders, so external consumers
            // resolve `T?` parameters and `(T, U, …)` tuple types in
            // our public surface.
            || fullName == "System.Nullable`1"
            || fullName == "System.ValueTuple`1"
            || fullName == "System.ValueTuple`2"
            || fullName == "System.ValueTuple`3"
            || fullName == "System.ValueTuple`4"
            || fullName == "System.ValueTuple`5"
            || fullName == "System.ValueTuple`6"
            || fullName == "System.ValueTuple`7"
            || fullName == "System.ValueTuple`8"
            // Issue #806: iterator state-machine classes implement
            // IEnumerable / IEnumerator / IDisposable. The host-process
            // typeof() of these returns the implementation-assembly
            // (System.Private.CoreLib) instance, but the public
            // contract lives in System.Runtime (via type forwarders).
            // Routing through System.Runtime keeps the runtime's
            // interface-lookup happy and avoids EntryPointNotFoundException
            // on iterator `GetEnumerator` dispatch from C# consumers.
            || fullName == "System.IDisposable"
            || fullName == "System.Collections.IEnumerable"
            || fullName == "System.Collections.IEnumerator"
            || fullName == "System.Collections.Generic.IEnumerable`1"
            || fullName == "System.Collections.Generic.IEnumerator`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerator`1";
    }

    internal TypeReferenceHandle GetTypeReference(Type type)
    {
        if (this.cache.TypeRefs.TryGetValue(type, out var existing))
        {
            return existing;
        }

        // Nested types: resolution scope is the TypeRef of the declaring type,
        // namespace is empty, name is the short name only. Works for the
        // open generic definition of a nested generic type as well (Reflection
        // treats Dictionary`2+Enumerator as nested under Dictionary`2).
        EntityHandle resolutionScope;
        StringHandle @namespace;
        if (type.IsNested && type.DeclaringType is Type declaring)
        {
            resolutionScope = this.GetTypeReference(declaring);
            @namespace = default;
        }
        else if (IsCoreLibBaseType(type))
        {
            // Issue #242: base types (Object, ValueType, Enum, Attribute)
            // must reference System.Runtime — the public facade — so that
            // consuming C#/F# projects can resolve them. Other types in
            // System.Private.CoreLib (e.g. Dictionary<,>) keep pointing at
            // CoreLib because the runtime resolves them directly and they
            // may not have type-forwarders in System.Runtime.
            resolutionScope = this.GetSystemRuntimeAssemblyReference();
            @namespace = this.emitCtx.Metadata.GetOrAddString(type.Namespace ?? string.Empty);
        }
        else
        {
            resolutionScope = this.GetAssemblyReference(type.Assembly);
            @namespace = this.emitCtx.Metadata.GetOrAddString(type.Namespace ?? string.Empty);
        }

        var handle = this.emitCtx.Metadata.AddTypeReference(
            resolutionScope: resolutionScope,
            @namespace: @namespace,
            name: this.emitCtx.Metadata.GetOrAddString(type.Name));
        this.cache.TypeRefs[type] = handle;
        return handle;
    }

    /// <summary>
    /// Returns a metadata handle suitable for use as the parent of a MemberRef.
    /// Returns a TypeRef for non-generic types and a TypeSpec encoding a
    /// <c>GenericInstantiation</c> for constructed generic types
    /// (e.g. <c>List&lt;int&gt;</c>, <c>Dictionary&lt;string, int&gt;</c>).
    /// </summary>
    internal EntityHandle GetTypeHandleForMember(Type type)
    {
        if (type.IsConstructedGenericType)
        {
            if (this.cache.TypeSpecs.TryGetValue(type, out var existingSpec))
            {
                return existingSpec;
            }

            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeClrType(encoder, type);
            var spec = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            this.cache.TypeSpecs[type] = spec;
            return spec;
        }

        return this.GetTypeReference(type);
    }

    private static ImmutableArray<TypeSymbol> GetGenericTypeArguments(TypeSymbol type)
    {
        var args = type switch
        {
            StructSymbol s => s.TypeArguments,
            InterfaceSymbol i => i.TypeArguments,
            ImportedTypeSymbol it => it.TypeArguments,
            _ => default,
        };

        if (!args.IsDefaultOrEmpty)
        {
            return args;
        }

        // ADR-0087 §3 R3+R4: imported CLR constructed generics may carry
        // their type arguments only on the CLR `Type` (the binder elides
        // `TypeArguments` when the GS-side use site doesn't need them).
        // Recover them by inspecting `ClrType.GenericTypeArguments` so
        // structural unification still succeeds for `List[int32]` /
        // `Dictionary[string, int32]` actual arguments.
        var clr = type?.ClrType;
        if (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var clrArgs = clr.GenericTypeArguments;
            var builder = ImmutableArray.CreateBuilder<TypeSymbol>(clrArgs.Length);
            for (int i = 0; i < clrArgs.Length; i++)
            {
                builder.Add(TypeSymbol.FromClrType(clrArgs[i]));
            }

            return builder.MoveToImmutable();
        }

        return default;
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns <see langword="true"/> when
    /// <paramref name="structSym"/> is a user-declared generic type
    /// reference whose body/field/method/ctor references must be
    /// parented at a <c>TypeSpec</c> rather than the bare TypeDef row.
    /// </summary>
    internal static bool IsUserGenericTypeReference(StructSymbol structSym)
    {
        if (structSym == null)
        {
            return false;
        }

        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            return true;
        }

        var def = structSym.Definition ?? structSym;
        return !def.TypeParameters.IsDefaultOrEmpty;
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns a <c>TypeSpec</c> EntityHandle for a
    /// user-declared generic type. When <paramref name="structSym"/>
    /// carries <see cref="StructSymbol.TypeArguments"/> the spec
    /// encodes the construction (<c>Box`1&lt;int32&gt;</c>); when it is
    /// the open definition the spec encodes the self-instantiation
    /// (<c>Box`1&lt;!0,...&gt;</c>) which is the only valid receiver
    /// type for the definition's own instance bodies (ECMA-335 II.10.3.1).
    /// </summary>
    internal EntityHandle GetUserStructTypeSpec(StructSymbol structSym)
    {
        if (this.userStructTypeSpecCache.TryGetValue(structSym, out var cached))
        {
            return cached;
        }

        var def = structSym.Definition ?? structSym;
        if (!this.cache.StructTypeDefs.TryGetValue(def, out var defHandle))
        {
            throw new InvalidOperationException(
                $"User generic type '{def.Name}' has no emitted TypeDef when constructing TypeSpec.");
        }

        ImmutableArray<TypeSymbol> typeArgs;
        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            typeArgs = structSym.TypeArguments;
        }
        else
        {
            // Open definition → encode self-instantiation using the
            // definition's own type parameters as arguments. Each will
            // encode as `VAR(idx)` via EncodeTypeSymbol after R2.
            var defTps = def.TypeParameters;
            var bld = ImmutableArray.CreateBuilder<TypeSymbol>(defTps.Length);
            foreach (var tp in defTps)
            {
                bld.Add(tp);
            }

            typeArgs = bld.MoveToImmutable();
        }

        var sigBlob = new BlobBuilder();
        var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
        var gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: !def.IsClass);
        foreach (var arg in typeArgs)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), arg);
        }

        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userStructTypeSpecCache[structSym] = spec;
        return spec;
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns a <c>MemberRef</c> handle for a field
    /// on a user-declared generic type, parented at the
    /// <c>TypeSpec</c> for <paramref name="containingType"/>.
    /// The MemberRef's signature is encoded from the OPEN definition's
    /// field — type-parameter slots round-trip as <c>VAR(idx)</c>.
    /// </summary>
    internal EntityHandle GetUserStructFieldRef(StructSymbol containingType, FieldSymbol fieldOnContaining)
    {
        var def = containingType.Definition ?? containingType;
        FieldSymbol defField = null;
        foreach (var candidate in def.Fields)
        {
            if (candidate.Name == fieldOnContaining.Name)
            {
                defField = candidate;
                break;
            }
        }

        if (defField == null)
        {
            // ADR-0029 backing-field fallback: synthesised members (auto-property,
            // field-like event) live alongside Fields under different containers.
            defField = fieldOnContaining;
        }

        var key = (containingType, defField);
        if (this.userStructFieldRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserStructTypeSpec(containingType);
        var sigBlob = new BlobBuilder();

        // Issue #810: when the containing type is a generic iterator
        // state-machine class, the FieldDef's signature was encoded with
        // outer-method TPs translated to Var(idx). The MemberRef sig
        // MUST match — push the SM's remap so EncodeTypeSymbol routes
        // the same TPs through the same Var(idx) slots here.
        using (this.PushSmRemap(containingType.Definition ?? containingType))
        {
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), defField.Type);
        }

        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(defField.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userStructFieldRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns the correct token for a field reference.
    /// For a non-generic type returns the bare <c>FieldDef</c>; for a
    /// user-declared generic type returns a <c>MemberRef</c> parented
    /// at the constructed (or self-) <c>TypeSpec</c>.
    /// </summary>
    internal EntityHandle ResolveFieldToken(StructSymbol containingType, FieldSymbol field)
    {
        if (IsUserGenericTypeReference(containingType))
        {
            return this.GetUserStructFieldRef(containingType, field);
        }

        return this.cache.StructFieldDefs[field];
    }

    /// <summary>
    /// ADR-0089 / issue #1030: returns the correct token for an interface
    /// static field reference. A non-generic interface uses the bare
    /// <c>FieldDef</c> row emitted on its TypeDef; a generic interface uses a
    /// <c>MemberRef</c> parented at the constructed (or self-) <c>TypeSpec</c>
    /// so each closed construction observes independent static storage.
    /// </summary>
    /// <param name="containingInterface">The owning interface (definition or constructed).</param>
    /// <param name="field">The interface static field.</param>
    /// <returns>The field reference token.</returns>
    internal EntityHandle ResolveInterfaceFieldToken(InterfaceSymbol containingInterface, FieldSymbol field)
    {
        if (IsUserGenericInterfaceReference(containingInterface))
        {
            return this.GetUserInterfaceFieldRef(containingInterface, field);
        }

        return this.cache.StructFieldDefs[field];
    }
}
