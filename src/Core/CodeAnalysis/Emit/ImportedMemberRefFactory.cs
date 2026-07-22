// <copyright file="ImportedMemberRefFactory.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // elements should appear in the correct order (the delegate-shape caches keep their original ReflectionMetadataEmitter band position, interleaved with the factories that consume them)
#pragma warning disable SA1202 // 'internal' members should come before 'private' members (methods keep their original ReflectionMetadataEmitter band order: entry points interleaved with the private helpers they orchestrate)
#pragma warning disable SA1204 // static members should come before non-static (the open-definition / TypeBuilder-safe resolvers sit next to the member-ref factories that consume them, preserving band order)
#pragma warning disable SA1214 // readonly fields should appear before non-readonly fields (the delegate-shape caches keep their original ReflectionMetadataEmitter band position)
#pragma warning disable SA1515 // single-line comment preceded by blank line (inherited from the ReflectionMetadataEmitter band; bodies are verbatim moves)
#pragma warning disable SA1611 // parameter documentation missing — the API surface is mechanically lifted from ReflectionMetadataEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-18 (#1361): the imported / BCL member-and-type reference factory band.
/// Owns every method that renders an external (reference-context / BCL) type,
/// method, constructor, or field into an ECMA-335 <c>TypeRef</c> /
/// <c>TypeSpec</c> / <c>MemberRef</c> / <c>MethodSpec</c> row — the token
/// producers the body emitter and its collaborators call to reference the
/// outside world. Covers the element/typeof/assembly/type-reference resolvers
/// (<c>GetElementTypeToken</c>, <c>GetTypeOfToken</c>,
/// <c>GetTypeReference</c>, <c>GetTypeHandleForMember</c>, the
/// <c>System.Runtime</c> facade assembly-ref), the method / ctor / field
/// MemberRef factories (<c>GetMethodReference</c>,
/// <c>GetMethodEntityHandle</c>, <c>GetCtorReference</c>,
/// <c>GetFieldReference</c> and the constructed-generic variants), the
/// symbolic-user-type-argument nullable / tuple / map MemberRef families, and
/// the reified <c>Func</c>/<c>Action</c> delegate MemberRef producers, plus the
/// open-definition / TypeBuilder-safe reflection helpers they share.
/// </summary>
/// <remarks>
/// <para>
/// This is the near-pure move the decomposition plan flagged: the state these
/// factories dedup against already lives on <see cref="MetadataTokenCache"/>
/// (moved in PR-E-2), so every ref-cache dictionary is reached via
/// <see cref="cache"/> and no metadata state relocates here. The only fields
/// that move with the band are the three reified-delegate-shape caches
/// (<c>functionDelegate*Cache</c>), which were RME privates consumed solely by
/// the delegate MemberRef producers.
/// </para>
/// <para>
/// Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// SignatureEncoder idiom) because the band reaches
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>,
/// <see cref="GenericRemapState"/>, the extracted
/// <see cref="SignatureEncoder"/> (signature/type encoding), the
/// <see cref="StateMachineEmitter"/> plans, AND several user-token resolvers
/// that only move in PR-E-19
/// (<see cref="UserTokenResolver.GetUserStructTypeSpec"/>,
/// <see cref="UserTokenResolver.GetUserInterfaceTypeSpec"/>,
/// <see cref="UserTokenResolver.FunctionTypeNeedsSymbolicDelegate"/>).
/// Those temporary couplings are reached through <see cref="outer"/> and are
/// resolved when the user-token-resolution band is extracted (E-19). Direct
/// convenience fields hold the shared <see cref="EmitContext"/> /
/// <see cref="MetadataTokenCache"/> / <see cref="GenericRemapState"/> /
/// <see cref="SignatureEncoder"/> read off the back-reference. Method bodies
/// are verbatim moves; emitted PEs are byte-identical with the pre-E-18
/// baseline.
/// </para>
/// </remarks>
internal sealed class ImportedMemberRefFactory
{
    private readonly ReflectionMetadataEmitter outer;
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly GenericRemapState remaps;
    private readonly SignatureEncoder signatures;

    public ImportedMemberRefFactory(ReflectionMetadataEmitter outer)
    {
        this.outer = outer ?? throw new ArgumentNullException(nameof(outer));
        this.emitCtx = outer.emitCtx;
        this.cache = outer.cache;
        this.remaps = outer.remaps;
        this.signatures = outer.signatures ?? throw new ArgumentNullException(nameof(outer));
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
                this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), nullableTpElement);
                return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            }

            return this.GetElementTypeToken(nullableTpInner);
        }

        // Issue #1298: `E?` over a user-declared enum tokenises as a TypeSpec
        // naming the generic instantiation `System.Nullable<E>`. This is the
        // token consumed by `box Nullable<E>` in the lifted enum-equality emit
        // (and by `initobj` when zero-initialising such a slot).
        //
        // Issue #1475: the same TypeSpec form applies to `S?` over a
        // user-declared value-type struct (no runtime `ClrType`). Recognise
        // both user value-type underlyings here so the null-conditional emit
        // can `initobj`/`box` the `Nullable<UserT>` slot.
        if (element is NullableTypeSymbol nullableUserVtElement
            && (nullableUserVtElement.UnderlyingType is EnumSymbol
                || (nullableUserVtElement.UnderlyingType is StructSymbol userVtStruct && !userVtStruct.IsClass)))
        {
            var sigBlob = new BlobBuilder();
            this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), nullableUserVtElement);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        // Issue #2498: nullable-reference annotations do not change the CLR
        // element token. Forward same-compilation classes/interfaces/delegates
        // through their underlying symbol just as imported nullable references
        // already flow through the shared CLR Type.
        if (element is NullableTypeSymbol nullableReferenceElement
            && !NullableLifting.IsAnyValueTypeNullable(nullableReferenceElement))
        {
            return this.GetElementTypeToken(nullableReferenceElement.UnderlyingType);
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
            this.signatures.EncodeTypeSymbol(encoder, nestedArr);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is SliceTypeSymbol nestedSlice)
        {
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.signatures.EncodeTypeSymbol(encoder, nestedSlice);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is ImportedTypeSymbol symbolicImported
            && !symbolicImported.TypeArguments.IsDefaultOrEmpty
            && !symbolicImported.HasTypeParameterArgument
            && symbolicImported.TypeArguments.Any(TypeSymbol.RequiresSymbolicProjection))
        {
            var sigBlob = new BlobBuilder();
            this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), symbolicImported);
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
            && symbolicTuple.Arity >= 2)
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
            this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), tpImported);
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
            if (ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym))
            {
                return this.outer.userTokens.GetUserStructTypeSpec(structSym);
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
            // Issue #1477: a synthesized closure / capture-box class is also
            // generic over enclosing TYPE parameters, so any TP present in the
            // active remap (class or method) maps to the synthesized class's
            // own VAR(idx) slot.
            if (this.remaps.ActiveLambdaMethodTypeParamRemap != null
                && this.remaps.ActiveLambdaMethodTypeParamRemap.TryGetValue(tpSym, out var lambdaMethodOrd))
            {
                // Issue #2118: reference to an enclosing type parameter inside a
                // generic-promoted non-capturing lambda's signature/body maps to
                // the lambda method's own MVar(idx) slot.
                encoder.GenericMethodTypeParameter(lambdaMethodOrd);
            }
            else if (this.remaps.ActiveIteratorStateMachineRemap != null
                && this.remaps.ActiveIteratorStateMachineRemap.TryGetValue(tpSym, out var smClassOrd))
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
            if (ReflectionMetadataEmitter.IsUserGenericInterfaceReference(ifaceSym))
            {
                var sigBlob = new BlobBuilder();
                this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), ifaceSym);
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

    private AssemblyReferenceHandle GetAssemblyReference(Assembly assembly)
    {
        if (this.cache.AssemblyRefs.TryGetValue(assembly, out var existing))
        {
            return existing;
        }

        var name = assembly.GetName();
        var publicKeyToken = name.GetPublicKeyToken();
        var publicKeyOrTokenBlob = publicKeyToken is { Length: > 0 }
            ? this.emitCtx.Metadata.GetOrAddBlob(publicKeyToken)
            : default(BlobHandle);
        var handle = this.emitCtx.Metadata.AddAssemblyReference(
            name: this.emitCtx.Metadata.GetOrAddString(name.Name ?? string.Empty),
            version: name.Version ?? new Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle));
        this.cache.AssemblyRefs[assembly] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #242: Returns an AssemblyReferenceHandle for <c>System.Runtime</c>,
    /// the public facade assembly that external consumers (C#/F# projects)
    /// reference. Used as the resolution scope for base-type TypeRefs
    /// (System.Object, System.ValueType, System.Enum) so that compiled
    /// libraries are consumable without requiring a direct reference to
    /// <c>System.Private.CoreLib</c>.
    /// </summary>
    private AssemblyReferenceHandle GetSystemRuntimeAssemblyReference()
    {
        if (!this.cache.SystemRuntimeAssemblyRef.IsNil)
        {
            return this.cache.SystemRuntimeAssemblyRef;
        }

        AssemblyName sysRuntimeName;
        try
        {
            sysRuntimeName = Assembly.Load("System.Runtime").GetName();
        }
        catch
        {
            // Fallback: construct the identity using the well-known .NET
            // public key token (b03f5f7f11d50a3a) and the host CoreLib version.
            sysRuntimeName = new AssemblyName("System.Runtime")
            {
                Version = typeof(object).Assembly.GetName().Version ?? new Version(0, 0, 0, 0),
            };
            sysRuntimeName.SetPublicKeyToken([0xb0, 0x3f, 0x5f, 0x7f, 0x11, 0xd5, 0x0a, 0x3a]);
        }

        var publicKeyToken = sysRuntimeName.GetPublicKeyToken();
        var publicKeyOrTokenBlob = publicKeyToken is { Length: > 0 }
            ? this.emitCtx.Metadata.GetOrAddBlob(publicKeyToken)
            : default(BlobHandle);
        this.cache.SystemRuntimeAssemblyRef = this.emitCtx.Metadata.AddAssemblyReference(
            name: this.emitCtx.Metadata.GetOrAddString(sysRuntimeName.Name ?? "System.Runtime"),
            version: sysRuntimeName.Version ?? new Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle));
        return this.cache.SystemRuntimeAssemblyRef;
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
            this.signatures.EncodeClrType(encoder, type);
            var spec = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            this.cache.TypeSpecs[type] = spec;
            return spec;
        }

        return this.GetTypeReference(type);
    }

    /// <summary>
    /// For a method on a constructed generic type, return the corresponding
    /// method on the open generic definition; for non-generic declaring types,
    /// returns the input. The open method's parameter / return types reference
    /// the declaring type's generic parameters as <c>GenericTypeParameter</c>,
    /// which <see cref="SignatureEncoder.EncodeClrType"/> emits as <c>!N</c>.
    /// </summary>
    private static MethodInfo GetOpenMethod(MethodInfo method)
    {
        var declaring = method.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return method;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetMethods(
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (SameMetadataDefinition(candidate, method))
            {
                return candidate;
            }
        }

        var parameters = method.GetParameters();
        var fallback = open.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(candidate =>
                candidate.Name == method.Name
                && candidate.IsStatic == method.IsStatic
                && candidate.IsGenericMethod == method.IsGenericMethod
                && candidate.GetParameters().Length == parameters.Length);
        if (fallback != null)
        {
            return fallback;
        }

        return method;
    }

    private static ConstructorInfo GetOpenCtor(ConstructorInfo ctor)
    {
        var declaring = ctor.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return ctor;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (SameMetadataDefinition(candidate, ctor))
            {
                return candidate;
            }
        }

        var parameters = ctor.GetParameters();
        var fallback = open.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(candidate => candidate.GetParameters().Length == parameters.Length);
        if (fallback != null)
        {
            return fallback;
        }

        return ctor;
    }

    internal static bool SameMetadataDefinition(MemberInfo candidate, MemberInfo member)
    {
        try
        {
            return candidate.MetadataToken == member.MetadataToken && candidate.Module == member.Module;
        }
        catch (NotSupportedException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static bool ContainsTypeBuilderGenericArgument(Type type)
    {
        if (type == null)
        {
            return false;
        }

        if (type is TypeBuilder)
        {
            return true;
        }

        if (type.HasElementType)
        {
            return ContainsTypeBuilderGenericArgument(type.GetElementType());
        }

        if (!type.IsGenericType)
        {
            return false;
        }

        try
        {
            return type.GetGenericArguments().Any(ContainsTypeBuilderGenericArgument);
        }
        catch (NotSupportedException)
        {
            return false;
        }
    }

    private static MethodInfo ResolveTypeBuilderConstructedGenericMethod(MethodInfo method)
    {
        var declaring = method?.DeclaringType;
        if (declaring == null || !declaring.IsConstructedGenericType || !ContainsTypeBuilderGenericArgument(declaring))
        {
            return method;
        }

        var openMethod = GetOpenMethod(method);
        return openMethod != null && openMethod.DeclaringType?.IsGenericTypeDefinition == true
            ? TypeBuilder.GetMethod(declaring, openMethod)
            : method;
    }

    private static ConstructorInfo ResolveTypeBuilderConstructedGenericCtor(ConstructorInfo ctor)
    {
        var declaring = ctor?.DeclaringType;
        if (declaring == null || !declaring.IsConstructedGenericType || !ContainsTypeBuilderGenericArgument(declaring))
        {
            return ctor;
        }

        var openCtor = GetOpenCtor(ctor);
        return openCtor != null && openCtor.DeclaringType?.IsGenericTypeDefinition == true
            ? TypeBuilder.GetConstructor(declaring, openCtor)
            : ctor;
    }

    private static FieldInfo ResolveTypeBuilderConstructedGenericField(FieldInfo field)
    {
        var declaring = field?.DeclaringType;
        if (!ContainsTypeBuilderGenericArgument(declaring) || declaring == null || !declaring.IsConstructedGenericType)
        {
            return field;
        }

        var openType = declaring.GetGenericTypeDefinition();
        var openField = openType.GetField(
            field.Name,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        return openField != null ? TypeBuilder.GetField(declaring, openField) : field;
    }

    internal static MethodInfo GetTypeBuilderSafePropertyAccessor(PropertyInfo property, bool wantSetter, bool nonPublic = false)
    {
        var declaring = property?.DeclaringType;
        if (!ContainsTypeBuilderGenericArgument(declaring) || declaring == null || !declaring.IsConstructedGenericType)
        {
            return wantSetter
                ? property?.GetSetMethod(nonPublic)
                : property?.GetGetMethod(nonPublic);
        }

        var openProperty = ResolvePropertyOnOpenDefinition(declaring.GetGenericTypeDefinition(), property);
        var openAccessor = wantSetter
            ? openProperty?.GetSetMethod(nonPublic)
            : openProperty?.GetGetMethod(nonPublic);
        return openAccessor != null
            ? TypeBuilder.GetMethod(declaring, openAccessor)
            : null;
    }

    internal MemberReferenceHandle GetMethodReference(MethodInfo method)
    {
        method = ResolveTypeBuilderConstructedGenericMethod(method);
        if (this.cache.MethodRefs.TryGetValue(method, out var existing))
        {
            return existing;
        }

        var declaring = method.DeclaringType
            ?? throw new InvalidOperationException("Imported method has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);

        // For instance methods on constructed generic types, encode the signature
        // from the OPEN definition so parameters/returns reference declaring-type
        // generic params by position (!0, !1, ...). For non-generic declarings,
        // open == closed and parameter types are concrete.
        var openMethod = GetOpenMethod(method);

        // When the method itself is generic (e.g. Channel.CreateUnbounded<T>),
        // encode the MemberRef against its generic definition so `!!N` placeholders
        // referenced in the signature resolve correctly. The caller wraps the
        // resulting handle in a MethodSpecification.
        var openForMethodGenerics = openMethod.IsGenericMethod
            ? openMethod.GetGenericMethodDefinition()
            : openMethod;

        var sigBlob = new BlobBuilder();
        var sigEncoder = new BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: !method.IsStatic,
            genericParameterCount: openForMethodGenerics.IsGenericMethodDefinition ? openForMethodGenerics.GetGenericArguments().Length : 0);
        sigEncoder.Parameters(
                openForMethodGenerics.GetParameters().Length,
                returnType: r => this.signatures.EncodeReturnClr(r, openForMethodGenerics.ReturnParameter, openForMethodGenerics.ReturnType),
                parameters: ps =>
                {
                    foreach (var p in openForMethodGenerics.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            // out / ref parameters: encode as managed pointer to the element type.
                            this.signatures.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.signatures.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.MethodRefs[method] = handle;
        return handle;
    }

    // Phase E: returns a callable EntityHandle for any MethodInfo, wrapping
    // constructed generic methods in a MethodSpecification per ECMA-335 II.23.2.15.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method)
    {
        return this.GetMethodEntityHandle(method, default(ImmutableArray<TypeSymbol>));
    }

    internal EntityHandle GetMethodEntityHandle(MethodInfo method, TypeSymbol containingTypeSymbol)
    {
        return this.GetMethodEntityHandle(method, default(ImmutableArray<TypeSymbol>), containingTypeSymbol);
    }

    // Issue #320: callable EntityHandle for a constructed generic method whose
    // explicit type arguments may include user-defined types. User-defined type
    // arguments have no reference-context CLR type, so the method was closed with
    // a System.Object placeholder; the real type-argument symbols are encoded into
    // the method specification here (as their own TypeDef tokens) instead of the
    // placeholder. When typeArgSymbols is default the placeholder CLR arguments are
    // encoded, preserving the BCL-only behavior.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        return this.GetMethodEntityHandle(method, typeArgSymbols, null);
    }

    internal EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols, TypeSymbol containingTypeSymbol)
    {
        if (TryCreateMemberReferenceForConstructedSymbolicContainer(method, containingTypeSymbol, out var symbolicRef))
        {
            if (!method.IsGenericMethod || method.IsGenericMethodDefinition)
            {
                return symbolicRef;
            }

            var symbolicClosedArgs = method.GetGenericArguments();
            var symbolicSigBlob = new BlobBuilder();
            var symbolicArgsEncoder = new BlobEncoder(symbolicSigBlob).MethodSpecificationSignature(symbolicClosedArgs.Length);
            for (var i = 0; i < symbolicClosedArgs.Length; i++)
            {
                if (!typeArgSymbols.IsDefaultOrEmpty
                    && i < typeArgSymbols.Length
                    && TypeSymbol.RequiresSymbolicProjection(typeArgSymbols[i]))
                {
                    this.signatures.EncodeTypeSymbol(symbolicArgsEncoder.AddArgument(), typeArgSymbols[i]);
                }
                else
                {
                    this.signatures.EncodeClrType(symbolicArgsEncoder.AddArgument(), symbolicClosedArgs[i]);
                }
            }

            return this.emitCtx.Metadata.AddMethodSpecification(symbolicRef, this.emitCtx.Metadata.GetOrAddBlob(symbolicSigBlob));
        }

        if (!method.IsGenericMethod || method.IsGenericMethodDefinition)
        {
            return this.GetMethodReference(method);
        }

        // The placeholder-closed MethodInfo is identical across distinct
        // user-type arguments (all close to <object>), so the cache must be keyed
        // by the symbol arguments too. Issue #420 (P3-7): previously this case
        // bypassed the cache entirely, producing duplicate MethodSpec rows when
        // the same generic method was referenced multiple times with the same
        // user-type generic args.
        var hasSymbolArgs = !typeArgSymbols.IsDefaultOrEmpty
            && typeArgSymbols.Any(TypeSymbol.RequiresSymbolicProjection);
        if (!hasSymbolArgs)
        {
            if (this.cache.MethodSpecs.TryGetValue(method, out var existing))
            {
                return existing;
            }
        }
        else
        {
            var symbolKey = new MetadataTokenCache.MethodSpecSymbolKey(method, typeArgSymbols);
            if (this.cache.MethodSpecsWithSymbolArgs.TryGetValue(symbolKey, out var existingSym))
            {
                return existingSym;
            }
        }

        var openDef = method.GetGenericMethodDefinition();
        var openRef = this.GetMethodReference(openDef);

        var closedArgs = method.GetGenericArguments();
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(closedArgs.Length);
        for (var i = 0; i < closedArgs.Length; i++)
        {
            // Issue #320: encode a user-defined type argument via its symbol so it
            // resolves to the emitted TypeDef; BCL arguments use the closed CLR type.
            // Issue #671: also recurse through nested constructed generics so a
            // `MyGeneric<List<MyGs>>` argument is encoded symbolically rather than
            // collapsing to System.Object at the placeholder.
            if (!typeArgSymbols.IsDefaultOrEmpty
                && i < typeArgSymbols.Length
                && TypeSymbol.RequiresSymbolicProjection(typeArgSymbols[i]))
            {
                this.signatures.EncodeTypeSymbol(argsEncoder.AddArgument(), typeArgSymbols[i]);
            }
            else
            {
                this.signatures.EncodeClrType(argsEncoder.AddArgument(), closedArgs[i]);
            }
        }

        var spec = this.emitCtx.Metadata.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        if (!hasSymbolArgs)
        {
            this.cache.MethodSpecs[method] = spec;
        }
        else
        {
            this.cache.MethodSpecsWithSymbolArgs[new MetadataTokenCache.MethodSpecSymbolKey(method, typeArgSymbols)] = spec;
        }

        return spec;
    }

    private bool TryCreateMemberReferenceForConstructedSymbolicContainer(
        MethodInfo method,
        TypeSymbol containingTypeSymbol,
        out MemberReferenceHandle handle)
    {
        handle = default;
        if (method == null
            || !TryNormalizeToSymbolicContainer(containingTypeSymbol, out var openDefinition, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty)
        {
            return false;
        }

        // Issue #774: when the method is declared on a non-generic base
        // (e.g. `IEnumerator.MoveNext()` inherited via `IEnumerator<T>`, or
        // `IDisposable.Dispose()` on the same enumerator), encoding a
        // symbolic generic parent TypeSpec produces a verifier-rejected
        // MemberRef (`MoveNext` is not declared on `IEnumerator<>`). Let the
        // plain MemberRef path encode the parent as the actual non-generic
        // declaring type by short-circuiting here.
        var methodDecl = method.DeclaringType;
        if (methodDecl != null && !methodDecl.IsGenericType && methodDecl != openDefinition)
        {
            return false;
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
        if (methodDecl != null
            && methodDecl.IsGenericType
            && openDefinition != null)
        {
            var methodDeclOpen = methodDecl.IsGenericTypeDefinition ? methodDecl : methodDecl.GetGenericTypeDefinition();
            if (!SameOpenTypeDefinition(methodDeclOpen, openDefinition))
            {
                if (TryFindImplementedInterfaceInstantiation(openDefinition, methodDeclOpen, out var ifaceInstantiation))
                {
                    var ifaceArgs = ifaceInstantiation.GetGenericArguments();
                    var symbolicIfaceArgs = ImmutableArray.CreateBuilder<TypeSymbol>(ifaceArgs.Length);
                    foreach (var ifa in ifaceArgs)
                    {
                        symbolicIfaceArgs.Add(MemberLookup.MapOpenClrTypeToSymbolic(ifa, openDefinition, typeArguments));
                    }

                    openDefinition = methodDeclOpen;
                    typeArguments = symbolicIfaceArgs.MoveToImmutable();
                }
            }
        }

        // Synthesize an ImportedTypeSymbol view of the receiver so the
        // parent TypeSpec encoder retains its constructed arguments uniformly
        // — regardless of whether the actual
        // receiver was an ImportedTypeSymbol, a SequenceTypeSymbol with
        // null ClrType (issue #774), or an AsyncSequenceTypeSymbol with
        // null ClrType.
        var symbolicView = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(this.GetErasedObjectArgs(openDefinition)),
            openDefinition,
            typeArguments);

        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), symbolicView);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));
        var openMethod = ResolveMethodOnOpenDefinition(openDefinition, method);
        var openForMethodGenerics = openMethod.IsGenericMethod
            ? openMethod.GetGenericMethodDefinition()
            : openMethod;

        var sigBlob = new BlobBuilder();
        var sigEncoder = new BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: !method.IsStatic,
            genericParameterCount: openForMethodGenerics.IsGenericMethodDefinition ? openForMethodGenerics.GetGenericArguments().Length : 0);
        sigEncoder.Parameters(
            openForMethodGenerics.GetParameters().Length,
            returnType: r => this.signatures.EncodeReturnClr(r, openForMethodGenerics.ReturnParameter, openForMethodGenerics.ReturnType),
            parameters: ps =>
            {
                foreach (var p in openForMethodGenerics.GetParameters())
                {
                    var paramType = p.ParameterType;
                    if (paramType.IsByRef)
                    {
                        this.signatures.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                    }
                    else
                    {
                        this.signatures.EncodeClrType(ps.AddParameter().Type(), paramType);
                    }
                }
            });

        handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return true;
    }

    /// <summary>
    /// Walks <paramref name="openDefinition"/>'s implemented interfaces and
    /// returns the constructed instance that uses
    /// <paramref name="targetOpenInterface"/> as its open definition. The
    /// returned <see cref="Type"/>'s generic arguments are still in terms of
    /// <paramref name="openDefinition"/>'s generic parameters so they can be
    /// substituted via <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol})"/>.
    /// </summary>
    private static bool TryFindImplementedInterfaceInstantiation(Type openDefinition, Type targetOpenInterface, out Type instantiation)
    {
        foreach (var iface in openDefinition.GetInterfaces())
        {
            if (iface.IsGenericType && SameOpenTypeDefinition(iface.GetGenericTypeDefinition(), targetOpenInterface))
            {
                instantiation = iface;
                return true;
            }

            if (!iface.IsGenericType && SameOpenTypeDefinition(iface, targetOpenInterface))
            {
                instantiation = iface;
                return true;
            }
        }

        instantiation = null;
        return false;
    }

    /// <summary>
    /// Issue #1462: compares two generic type definitions (or non-generic
    /// types) for metadata identity rather than CLR reference identity. The
    /// receiver's <c>OpenDefinition</c> and the interfaces it implements are
    /// loaded through the <see cref="System.Reflection.MetadataLoadContext"/>
    /// of the referenced framework, whereas the well-known method's
    /// <see cref="MemberInfo.DeclaringType"/> may have been obtained via the
    /// compiler's own runtime <c>typeof(...)</c> (e.g.
    /// <c>typeof(IEnumerable&lt;object&gt;)</c> in the foreach lowerer). Those
    /// two <see cref="Type"/> objects describe the same logical type but are
    /// never reference-equal, so a <c>==</c> comparison silently fails and the
    /// interface-substitution redirect is skipped — emitting the receiver's own
    /// hiding member (e.g. <c>List&lt;T&gt;</c>'s struct-returning
    /// <c>GetEnumerator</c>) typed as the interface enumerator, which is
    /// unverifiable. Comparing by <see cref="Type.FullName"/> closes that gap.
    /// </summary>
    private static bool SameOpenTypeDefinition(Type a, Type b)
    {
        if (a == null || b == null)
        {
            return false;
        }

        if (a == b)
        {
            return true;
        }

        return a.FullName != null && a.FullName == b.FullName;
    }

    /// <summary>
    /// Issue #774: normalises any receiver type that carries open generic
    /// arguments (an <see cref="ImportedTypeSymbol"/> with
    /// <see cref="ImportedTypeSymbol.OpenDefinition"/>, a
    /// <see cref="SequenceTypeSymbol"/> with no <see cref="TypeSymbol.ClrType"/>,
    /// or its async counterpart) into the open CLR definition plus the
    /// symbolic argument list. Lets the symbolic-container MemberRef path
    /// fire uniformly for all three shapes.
    /// </summary>
    internal static bool TryNormalizeToSymbolicContainer(
        TypeSymbol containingTypeSymbol,
        out Type openDefinition,
        out ImmutableArray<TypeSymbol> typeArguments)
    {
        switch (containingTypeSymbol)
        {
            case ImportedTypeSymbol imp when imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty:
                openDefinition = imp.OpenDefinition;
                typeArguments = imp.TypeArguments;
                return true;
            case SequenceTypeSymbol seq when seq.ClrType == null:
                openDefinition = typeof(System.Collections.Generic.IEnumerable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(seq.ElementType);
                return true;
            case AsyncSequenceTypeSymbol aseq when aseq.ClrType == null:
                openDefinition = typeof(System.Collections.Generic.IAsyncEnumerable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(aseq.ElementType);
                return true;
            case NullableTypeSymbol nul when nul.UnderlyingType is TypeParameterSymbol nullableTp && nullableTp.HasValueTypeConstraint:
                // Issue #806: a `T?` receiver where T is an open value-type
                // type parameter has no constructed CLR `Nullable<T>` here —
                // route member-ref encoding through the symbolic container
                // path so the MemberRef parent is `Nullable<!!T>` against
                // System.Runtime, not against the current assembly.
                openDefinition = typeof(System.Nullable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(nullableTp);
                return true;
            default:
                openDefinition = null;
                typeArguments = default;
                return false;
        }
    }

    // Issue #821: choose the right erased `object` for an open generic
    // definition's MakeGenericType call. The open def may live in a
    // MetadataLoadContext (reference-pack assemblies); passing a live
    // `typeof(object)` to its MakeGenericType raises ArgumentException with
    // "type was not loaded by the MetadataLoadContext that loaded the
    // generic type or method." Use `emitCtx.CoreObjectType`, which is the
    // System.Object resolved through the active reference context, when the
    // open def lives outside the host runtime.
    private Type[] GetErasedObjectArgs(Type openDefinition)
    {
        var parameters = openDefinition.GetGenericArguments();
        var result = new Type[parameters.Length];
        var coreObject = ChooseErasedObjectType(openDefinition);
        for (var i = 0; i < parameters.Length; i++)
        {
            // Issue #806: a generic parameter with the `struct`
            // constraint cannot be closed with `System.Object`
            // (MakeGenericType throws ArgumentException). Use a
            // BCL value-type placeholder (`int32`) so the
            // symbolic-container path can construct the closed
            // type purely for parent-TypeSpec encoding. The
            // closed type's identity is irrelevant beyond the
            // open definition's reflection metadata.
            var p = parameters[i];
            if ((p.GenericParameterAttributes & System.Reflection.GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
            {
                result[i] = ChooseErasedValueTypeType(openDefinition);
            }
            else
            {
                result[i] = coreObject;
            }
        }

        return result;
    }

    private Type ChooseErasedValueTypeType(Type openDefinition)
    {
        var hostInt = typeof(int);
        if (openDefinition?.Assembly == hostInt.Assembly)
        {
            return hostInt;
        }

        return this.emitCtx.CoreInt32Type ?? hostInt;
    }

    private Type ChooseErasedObjectType(Type openDefinition)
    {
        // Same context as the open def → cheap path.
        var hostObject = typeof(object);
        if (openDefinition?.Assembly == hostObject.Assembly)
        {
            return hostObject;
        }

        return this.emitCtx.CoreObjectType ?? hostObject;
    }

    internal static MethodInfo ResolveMethodOnOpenDefinition(Type openDefinition, MethodInfo method)
    {
        if (openDefinition == null)
        {
            return method;
        }

        if (method.DeclaringType == openDefinition)
        {
            return method;
        }

        foreach (var candidate in openDefinition.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (SameMetadataDefinition(candidate, method))
            {
                return candidate;
            }
        }

        var fallback = openDefinition.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(candidate =>
                candidate.Name == method.Name
                && candidate.IsStatic == method.IsStatic
                && candidate.IsGenericMethod == method.IsGenericMethod
                && candidate.GetParameters().Length == method.GetParameters().Length);
        return fallback ?? method;
    }

    internal static PropertyInfo ResolvePropertyOnOpenDefinition(Type openDefinition, PropertyInfo property)
    {
        if (openDefinition == null)
        {
            return property;
        }

        if (property.DeclaringType == openDefinition)
        {
            return property;
        }

        foreach (var candidate in openDefinition.GetProperties(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (SameMetadataDefinition(candidate, property))
            {
                return candidate;
            }
        }

        return openDefinition.GetProperty(
            property.Name,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
    }

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR instance constructor.
    /// Handles both non-generic types (<c>StringBuilder()</c>) and constructed
    /// generic types (<c>List&lt;int&gt;()</c>, <c>Dictionary&lt;string, int&gt;()</c>).
    /// </summary>
    internal MemberReferenceHandle GetCtorReference(ConstructorInfo ctor)
        => this.GetCtorReference(ctor, containingTypeSymbol: null);

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR instance constructor on a
    /// possibly type-erased generic declaring type. When
    /// <paramref name="containingTypeSymbol"/> is an
    /// <see cref="ImportedTypeSymbol"/> whose <see cref="ImportedTypeSymbol.TypeArguments"/>
    /// contain one or more G# user-defined types (issue #671), the parent
    /// TypeSpec is encoded against those symbolic arguments (resolving to the
    /// real user-defined TypeDef tokens) instead of the type-erased
    /// <c>Open&lt;object,…&gt;</c> shape carried by <paramref name="ctor"/>.
    /// </summary>
    /// <param name="ctor">The (possibly type-erased) constructor selected by overload resolution.</param>
    /// <param name="containingTypeSymbol">The bound result type of the construction expression. May be <see langword="null"/>.</param>
    /// <returns>A MemberRef handle for the constructor on the correctly-typed parent.</returns>
    internal MemberReferenceHandle GetCtorReference(ConstructorInfo ctor, TypeSymbol containingTypeSymbol)
    {
        ctor = ResolveTypeBuilderConstructedGenericCtor(ctor);
        // Issue #671: when the containing type carries symbolic user-type
        // arguments, the cache key needs to discriminate per symbol set
        // (multiple distinct user-type closures share a single type-erased
        // ConstructorInfo).
        if (TryCreateCtorMemberReferenceForConstructedSymbolicContainer(ctor, containingTypeSymbol, out var symbolicHandle))
        {
            return symbolicHandle;
        }

        if (this.cache.CtorRefs.TryGetValue(ctor, out var existing))
        {
            return existing;
        }

        var declaring = ctor.DeclaringType
            ?? throw new InvalidOperationException("Imported constructor has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);
        var openCtor = GetOpenCtor(ctor);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            // out/ref parameter (e.g. an interpolated-string
                            // handler ctor's `out bool shouldAppend`): emit the
                            // BYREF prefix, then encode the element type.
                            this.signatures.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.signatures.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.CtorRefs[ctor] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #671: builds a constructor MemberRef whose parent TypeSpec is
    /// encoded from the original symbolic type arguments (resolving to G#
    /// user-defined TypeDef tokens) rather than the type-erased
    /// <c>Open&lt;object,…&gt;</c> shape baked into the constructor's
    /// <see cref="MemberInfo.DeclaringType"/>. Mirrors the method
    /// counterpart in <see cref="TryCreateMemberReferenceForConstructedSymbolicContainer"/>.
    /// </summary>
    /// <param name="ctor">The (type-erased) constructor.</param>
    /// <param name="containingTypeSymbol">The bound type of the call's result; expected to be an <see cref="ImportedTypeSymbol"/> carrying user-defined type args.</param>
    /// <param name="handle">On success, the new MemberRef handle.</param>
    /// <returns>Whether a symbolic-container MemberRef was produced.</returns>
    private bool TryCreateCtorMemberReferenceForConstructedSymbolicContainer(
        ConstructorInfo ctor,
        TypeSymbol containingTypeSymbol,
        out MemberReferenceHandle handle)
    {
        handle = default;
        if (ctor == null
            || containingTypeSymbol is not ImportedTypeSymbol imported
            || imported.OpenDefinition == null
            || imported.TypeArguments.IsDefaultOrEmpty
            || !(imported.HasTypeParameterArgument || imported.TypeArguments.Any(ReflectionMetadataEmitter.ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        var cacheKey = new MetadataTokenCache.CtorRefSymbolKey(ctor, imported.TypeArguments);
        if (this.cache.CtorRefsWithSymbolArgs.TryGetValue(cacheKey, out var cached))
        {
            handle = cached;
            return true;
        }

        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), imported);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));
        var openCtor = ResolveCtorOnOpenDefinition(imported.OpenDefinition, ctor);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            this.signatures.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.signatures.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.CtorRefsWithSymbolArgs[cacheKey] = handle;
        return true;
    }

    private static ConstructorInfo ResolveCtorOnOpenDefinition(Type openDefinition, ConstructorInfo ctor)
    {
        if (openDefinition == null)
        {
            return ctor;
        }

        if (ctor.DeclaringType == openDefinition)
        {
            return ctor;
        }

        foreach (var candidate in openDefinition.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (SameMetadataDefinition(candidate, ctor))
            {
                return candidate;
            }
        }

        var fallback = openDefinition.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(candidate => candidate.GetParameters().Length == ctor.GetParameters().Length);
        return fallback ?? ctor;
    }

    /// <summary>
    /// Issue #814 / ADR-0084 §L5: builds a <c>MemberRef</c> parented at the
    /// <c>TypeSpec</c> for <c>System.Nullable`1&lt;!!T&gt;</c> with signature
    /// <c>instance void .ctor(!0)</c>. The CLR substitutes <c>!0</c> against
    /// the parent's first generic argument at call time, so a single
    /// MemberRef serves every instantiation. Used by the
    /// <c>T → Nullable&lt;T&gt;</c> value-type lift when <c>T</c> is an open
    /// type parameter constrained to <c>struct</c> — the closed
    /// <see cref="ConstructorInfo"/> we normally route through
    /// <see cref="GetCtorReference(ConstructorInfo)"/> is unavailable because
    /// <see cref="TypeParameterSymbol"/> has no <see cref="Type"/>.
    /// </summary>
    /// <param name="nullableOfTp">A <see cref="NullableTypeSymbol"/> whose underlying type is an open <see cref="TypeParameterSymbol"/>.</param>
    /// <returns>The MemberRef handle for <c>Nullable&lt;!!T&gt;::.ctor(!0)</c>.</returns>
    internal MemberReferenceHandle GetNullableCtorMemberRefForOpenTypeParameter(NullableTypeSymbol nullableOfTp)
    {
        if (nullableOfTp?.UnderlyingType is not TypeParameterSymbol tp)
        {
            throw new InvalidOperationException(
                "GetNullableCtorMemberRefForOpenTypeParameter requires Nullable<TypeParameter>.");
        }

        if (this.cache.NullableOpenCtorMemberRefs.TryGetValue(tp, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfTp);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 1,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    // `!0`: the parent TypeSpec's first generic parameter
                    // (i.e. the inner type that Nullable<> is closed over).
                    ps.AddParameter().Type().GenericTypeParameter(0);
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableOpenCtorMemberRefs[tp] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #1298: gets a MemberRef for <c>System.Nullable`1&lt;E&gt;::.ctor(!0)</c>
    /// where <c>E</c> is a user-declared enum emitted in this assembly. The
    /// enum has no runtime CLR type, so the BCL-backed
    /// <see cref="WellKnownReferences"/> ctor path cannot construct it; instead
    /// the parent TypeSpec closes <c>Nullable&lt;&gt;</c> over the enum's TypeDef
    /// and the ctor signature refers to that argument as <c>!0</c>. Mirrors
    /// <see cref="GetNullableCtorMemberRefForOpenTypeParameter"/>.
    /// </summary>
    /// <param name="nullableOfEnum">A <c>Nullable&lt;E&gt;</c> over a user enum.</param>
    /// <returns>The constructor MemberRef.</returns>
    internal MemberReferenceHandle GetNullableCtorMemberRefForUserEnum(NullableTypeSymbol nullableOfEnum)
    {
        if (nullableOfEnum?.UnderlyingType is not EnumSymbol enumSym)
        {
            throw new InvalidOperationException(
                "GetNullableCtorMemberRefForUserEnum requires Nullable<EnumSymbol>.");
        }

        if (this.cache.NullableUserEnumCtorMemberRefs.TryGetValue(enumSym, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfEnum);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 1,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().GenericTypeParameter(0);
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableUserEnumCtorMemberRefs[enumSym] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #1475: gets a MemberRef for <c>System.Nullable`1&lt;S&gt;::.ctor(!0)</c>
    /// where <c>S</c> is a user-declared value-type struct emitted in this
    /// assembly (or a user enum, by delegation). The struct has no runtime CLR
    /// type, so the BCL-backed ctor path cannot construct it; instead the
    /// parent TypeSpec closes <c>Nullable&lt;&gt;</c> over the struct's emitted
    /// TypeDef/TypeSpec and the ctor signature refers to that argument as
    /// <c>!0</c>. Mirrors <see cref="GetNullableCtorMemberRefForUserEnum"/>.
    /// </summary>
    /// <param name="nullableOfUserVt">A <c>Nullable&lt;S&gt;</c> over a user value type (enum or value struct).</param>
    /// <returns>The constructor MemberRef.</returns>
    internal MemberReferenceHandle GetNullableCtorMemberRefForUserValueType(NullableTypeSymbol nullableOfUserVt)
    {
        // A user enum already has a dedicated cache + helper; reuse it so a
        // single MemberRef serves both the lift (issue #1298) and the
        // null-conditional (issue #1475) sites.
        if (nullableOfUserVt?.UnderlyingType is EnumSymbol)
        {
            return this.GetNullableCtorMemberRefForUserEnum(nullableOfUserVt);
        }

        if (nullableOfUserVt?.UnderlyingType is not StructSymbol structSym || structSym.IsClass)
        {
            throw new InvalidOperationException(
                "GetNullableCtorMemberRefForUserValueType requires Nullable<user enum or value struct>.");
        }

        if (this.cache.NullableUserStructCtorMemberRefs.TryGetValue(structSym, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfUserVt);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 1,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().GenericTypeParameter(0);
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableUserStructCtorMemberRefs[structSym] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #1572 / #2333: gets a MemberRef for
    /// <c>System.Nullable`1&lt;T&gt;::get_Value()</c> where <c>T</c> is either a
    /// user-declared value type emitted in this assembly (a value-kind
    /// <see cref="StructSymbol"/> or an <see cref="EnumSymbol"/>) or an open
    /// type parameter constrained to <c>struct</c>. Neither shape has a
    /// resolvable runtime CLR <see cref="Type"/> during emit, so the
    /// BCL-backed <see cref="WellKnownReferences.GetNullableGetValueReference"/>
    /// path cannot build the MemberRef; instead the parent TypeSpec closes
    /// <c>Nullable&lt;&gt;</c> over the emitted TypeDef/TypeSpec (or the
    /// generic-parameter var/mvar signature slot) and the getter returns
    /// <c>!0</c>. Used by the <c>(v!!)</c> unwrap, value-type narrowing-read
    /// emit, and the null-conditional receiver probe.
    /// </summary>
    /// <param name="nullableOfUserVt">A <c>Nullable&lt;T&gt;</c> over a user value type (enum or value struct) or a struct-constrained type parameter.</param>
    /// <returns>The <c>get_Value()</c> MemberRef.</returns>
    internal MemberReferenceHandle GetNullableGetValueMemberRefForUserValueType(NullableTypeSymbol nullableOfUserVt)
    {
        if (nullableOfUserVt == null || !NullableLifting.RequiresSymbolicNullableGetValue(nullableOfUserVt))
        {
            throw new InvalidOperationException(
                "GetNullableGetValueMemberRefForUserValueType requires Nullable<user enum, value struct, or struct-constrained type parameter>.");
        }

        var underlying = nullableOfUserVt.UnderlyingType;
        if (this.cache.NullableUserValueTypeGetValueMemberRefs.TryGetValue(underlying, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfUserVt);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 0,
                returnType: r => r.Type().GenericTypeParameter(0),
                parameters: _ => { });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("get_Value"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableUserValueTypeGetValueMemberRefs[underlying] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #2388: gets a MemberRef for
    /// <c>System.Nullable`1&lt;T&gt;::get_HasValue()</c> where <c>T</c> is a
    /// user-declared value type emitted in this assembly (a value-kind
    /// <see cref="StructSymbol"/> or an <see cref="EnumSymbol"/>). Mirrors
    /// <see cref="GetNullableGetValueMemberRefForUserValueType"/> exactly,
    /// except the getter returns <c>bool</c> instead of <c>!0</c>. Needed to
    /// HasValue-branch a nullable-lifted Stream C/D custom-operator call
    /// (e.g. a same-compilation struct's <c>operator ==</c>) over
    /// <c>Nullable&lt;UserStruct&gt;</c> operands, where no real CLR
    /// <see cref="System.Type"/> exists at emit time to resolve the
    /// reflection-based <see cref="WellKnownReferences.GetNullableGetHasValueReference"/>.
    /// </summary>
    /// <param name="nullableOfUserVt">A <c>Nullable&lt;T&gt;</c> over a user value type (enum or value struct).</param>
    /// <returns>The <c>get_HasValue()</c> MemberRef.</returns>
    internal MemberReferenceHandle GetNullableGetHasValueMemberRefForUserValueType(NullableTypeSymbol nullableOfUserVt)
    {
        if (nullableOfUserVt == null || !NullableLifting.RequiresSymbolicNullableGetValue(nullableOfUserVt))
        {
            throw new InvalidOperationException(
                "GetNullableGetHasValueMemberRefForUserValueType requires Nullable<user enum, value struct, or struct-constrained type parameter>.");
        }

        var underlying = nullableOfUserVt.UnderlyingType;
        if (this.cache.NullableUserValueTypeGetHasValueMemberRefs.TryGetValue(underlying, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfUserVt);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 0,
                returnType: r => r.Type().Boolean(),
                parameters: _ => { });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("get_HasValue"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableUserValueTypeGetHasValueMemberRefs[underlying] = handle;
        return handle;
    }

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR field on a possibly
    /// generic declaring type (e.g. <c>KeyValuePair&lt;K, V&gt;.Key</c>).
    /// </summary>
    internal MemberReferenceHandle GetFieldReference(FieldInfo field)
    {
        field = ResolveTypeBuilderConstructedGenericField(field);
        if (this.cache.FieldRefs.TryGetValue(field, out var existing))
        {
            return existing;
        }

        var declaring = field.DeclaringType
            ?? throw new InvalidOperationException("Imported field has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);

        // Use the open field's FieldType so it encodes as !N when applicable.
        var openField = declaring.IsConstructedGenericType
            ? declaring.GetGenericTypeDefinition().GetField(
                field.Name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                ?? field
            : field;

        var sigBlob = new BlobBuilder();
        this.signatures.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(field.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.FieldRefs[field] = handle;
        return handle;
    }

    internal MemberReferenceHandle GetFieldReference(FieldInfo field, TypeSymbol containingTypeSymbol)
    {
        if (!TryNormalizeToSymbolicContainer(containingTypeSymbol, out var openDefinition, out var typeArguments))
        {
            return this.GetFieldReference(field);
        }

        var openField = openDefinition.GetField(
            field.Name,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException(
                $"Open generic type '{openDefinition.FullName}' has no field '{field.Name}'.");
        var symbolicView = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(this.GetErasedObjectArgs(openDefinition)),
            openDefinition,
            typeArguments);
        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(
            new BlobEncoder(parentBlob).TypeSpecificationSignature(),
            symbolicView);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(
            this.emitCtx.Metadata.GetOrAddBlob(parentBlob));
        var sigBlob = new BlobBuilder();
        this.signatures.EncodeClrType(
            new BlobEncoder(sigBlob).FieldSignature(),
            openField.FieldType);
        return this.emitCtx.Metadata.AddMemberReference(
            parent,
            this.emitCtx.Metadata.GetOrAddString(field.Name),
            this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a field on a constructed generic type without
    /// calling <c>.GetField()</c> on the closed generic (which throws
    /// <see cref="NotSupportedException"/> when type arguments are MLC-loaded or
    /// TypeBuilder-backed). Resolves the field from the open generic type definition.
    /// </summary>
    internal MemberReferenceHandle GetFieldReferenceOnConstructedGeneric(Type closedGenericType, string fieldName)
    {
        var openType = closedGenericType.GetGenericTypeDefinition();
        var openField = openType.GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException(
                $"Open generic type '{openType.FullName}' has no field '{fieldName}'.");

        var parent = this.GetTypeHandleForMember(closedGenericType);

        var sigBlob = new BlobBuilder();
        this.signatures.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(fieldName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return handle;
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a constructor on a constructed generic type without
    /// calling <c>.GetConstructors()</c> on the closed generic (which throws
    /// <see cref="NotSupportedException"/> when type arguments are MLC-loaded or
    /// TypeBuilder-backed). Resolves the constructor from the open generic type definition.
    /// </summary>
    internal MemberReferenceHandle GetCtorReferenceOnConstructedGeneric(Type closedGenericType, int paramCount)
    {
        var openType = closedGenericType.GetGenericTypeDefinition();
        ConstructorInfo openCtor = null;
        foreach (var c in openType.GetConstructors())
        {
            if (c.GetParameters().Length == paramCount)
            {
                openCtor = c;
                break;
            }
        }

        if (openCtor == null)
        {
            throw new InvalidOperationException(
                $"Open generic type '{openType.FullName}' has no constructor of arity {paramCount}.");
        }

        var parent = this.GetTypeHandleForMember(closedGenericType);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            this.signatures.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.signatures.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return handle;
    }

    /// <summary>
    /// Issue #1449: Gets a MemberRef for a delegate's canonical
    /// <c>(object, IntPtr)</c> constructor in a TypeBuilder-safe way.
    /// <para>
    /// Calling <see cref="Type.GetConstructors()"/> on a constructed generic
    /// delegate type (e.g. <c>Func&lt;…&gt;</c> / <c>Action&lt;…&gt;</c>) that
    /// is realized as a reflection-emit <c>TypeBuilderInstantiation</c> throws
    /// <see cref="NotSupportedException"/> ("TypeBuilder generic instantiation
    /// does not support resolving members. Use TypeBuilder.GetConstructor
    /// instead."). This happens both when a type argument is a
    /// <see cref="TypeBuilder"/> closed in the same compilation (#671) and when
    /// the instantiation is constructed against the in-progress assembly even
    /// though every type argument is a runtime type (#1449). In either case the
    /// MemberRef is built from the open generic definition's canonical ctor
    /// signature parented at the constructed-generic TypeSpec instead.
    /// </para>
    /// </summary>
    /// <param name="delegateType">The (possibly constructed-generic) delegate CLR type.</param>
    /// <returns>A MemberRef handle for the delegate's <c>(object, IntPtr)</c> constructor.</returns>
    internal MemberReferenceHandle GetDelegateCtorReference(Type delegateType)
    {
        if (delegateType.IsConstructedGenericType)
        {
            ConstructorInfo ctor;
            try
            {
                ctor = delegateType.GetConstructors()[0];
            }
            catch (NotSupportedException)
            {
                // Reflection-emit limitation: GetConstructors() throws on a
                // generic delegate realized as a TypeBuilderInstantiation. Build
                // the MemberRef from the open definition's canonical
                // (object, IntPtr) delegate ctor parented at the TypeSpec.
                return this.GetCtorReferenceOnConstructedGeneric(delegateType, paramCount: 2);
            }

            return this.GetCtorReference(ctor);
        }

        return this.GetCtorReference(delegateType.GetConstructors()[0]);
    }

    /// <summary>
    /// Issue #649: Gets the TypeSpec handle for a <c>ValueTuple&lt;...&gt;</c> whose element
    /// types include G#-defined types (StructSymbol) that lack a CLR backing type.
    /// Encodes each element type via <see cref="SignatureEncoder.EncodeTypeSymbol"/> so user-defined types
    /// are correctly referenced by their TypeDef handles.
    /// </summary>
    private EntityHandle GetTupleTypeSpec(TupleTypeSymbol tupleType)
    {
        var sigBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), tupleType);
        return this.emitCtx.Metadata.AddTypeSpecification(
            this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a tuple field (<c>Item1</c>...<c>Item7</c>) when
    /// the tuple's <see cref="TypeSymbol.ClrType"/> is null (element types include
    /// G#-defined types). Builds the field MemberRef against the symbolically-constructed
    /// <c>ValueTuple</c> TypeSpec.
    /// </summary>
    internal MemberReferenceHandle GetTupleFieldReference(TupleTypeSymbol tupleType, string fieldName)
    {
        var parent = this.GetTupleTypeSpec(tupleType);

        // Get the open field from the BCL ValueTuple generic definition for signature encoding.
        var openType = tupleType.Arity switch
        {
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            _ => throw new NotSupportedException(
                $"Symbolic tuple field ref not supported for arity {tupleType.Arity}."),
        };

        var openField = openType.GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.Public)
            ?? throw new InvalidOperationException(
                $"Open ValueTuple type has no field '{fieldName}'.");

        var sigBlob = new BlobBuilder();
        this.signatures.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(fieldName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a tuple constructor when the tuple's
    /// <see cref="TypeSymbol.ClrType"/> is null (element types include G#-defined
    /// types). Builds the ctor MemberRef against the symbolically-constructed
    /// <c>ValueTuple</c> TypeSpec.
    /// </summary>
    internal MemberReferenceHandle GetTupleCtorReference(TupleTypeSymbol tupleType)
    {
        var parent = this.GetTupleTypeSpec(tupleType);
        var arity = tupleType.Arity;

        var openType = arity switch
        {
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            _ => throw new NotSupportedException(
                $"Symbolic tuple ctor ref not supported for arity {arity}."),
        };

        ConstructorInfo openCtor = null;
        foreach (var c in openType.GetConstructors())
        {
            if (c.GetParameters().Length == arity)
            {
                openCtor = c;
                break;
            }
        }

        if (openCtor == null)
        {
            throw new InvalidOperationException(
                $"Open ValueTuple type of arity {arity} has no matching constructor.");
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        this.signatures.EncodeClrType(ps.AddParameter().Type(), p.ParameterType);
                    }
                });

        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #1481: builds a <c>TypeSpec</c> encoding
    /// <c>System.Collections.Generic.Dictionary`2&lt;K, V&gt;</c> with the key
    /// and value routed through <see cref="SignatureEncoder.EncodeTypeSymbol"/>, so an in-scope
    /// type parameter survives as a <c>Var</c>/<c>MVar</c> slot. Used when a
    /// <c>map[K, V]</c> literal's <see cref="TypeSymbol.ClrType"/> is null
    /// (e.g. <c>map[string, T]</c>) — the erased CLR fast-path is unavailable
    /// and the body construction must be parented at this reified TypeSpec so
    /// the value stored into the iterator state machine's reified
    /// <c>Dictionary&lt;…, !0&gt;</c> field verifies. Mirrors
    /// <see cref="GetTupleTypeSpec"/>.
    /// </summary>
    private EntityHandle GetMapTypeSpec(MapTypeSymbol mapType)
    {
        var dictionaryOpen = typeof(System.Collections.Generic.Dictionary<,>);
        var sigBlob = new BlobBuilder();
        var genInst = new BlobEncoder(sigBlob).TypeSpecificationSignature()
            .GenericInstantiation(
                this.GetTypeReference(dictionaryOpen),
                genericArgumentCount: 2,
                isValueType: false);
        this.signatures.EncodeTypeSymbol(genInst.AddArgument(), mapType.KeyType);
        this.signatures.EncodeTypeSymbol(genInst.AddArgument(), mapType.ValueType);
        return this.emitCtx.Metadata.AddTypeSpecification(
            this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #1481: gets a MemberRef for the parameterless
    /// <c>Dictionary`2::.ctor()</c> parented at the reified
    /// <see cref="GetMapTypeSpec"/> TypeSpec, for a <c>map[K, V]</c> literal
    /// whose <see cref="TypeSymbol.ClrType"/> is null. Mirrors
    /// <see cref="GetTupleCtorReference"/>.
    /// </summary>
    internal MemberReferenceHandle GetMapCtorReference(MapTypeSymbol mapType)
    {
        var parent = this.GetMapTypeSpec(mapType);
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, returnType: r => r.Void(), parameters: _ => { });
        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #1481: gets a MemberRef for
    /// <c>Dictionary`2::set_Item(!0, !1)</c> parented at the reified
    /// <see cref="GetMapTypeSpec"/> TypeSpec, used to populate a
    /// <c>map[K, V]</c> literal whose <see cref="TypeSymbol.ClrType"/> is null.
    /// The parameter signature references the dictionary's own generic
    /// parameters (<c>!0</c>/<c>!1</c>), as required for a MemberRef on a
    /// constructed generic type.
    /// </summary>
    internal MemberReferenceHandle GetMapSetItemReference(MapTypeSymbol mapType)
    {
        var parent = this.GetMapTypeSpec(mapType);
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                2,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().GenericTypeParameter(0);
                    ps.AddParameter().Type().GenericTypeParameter(1);
                });
        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("set_Item"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    // ADR-0087 §3 R6: cache for reified delegate (Func/Action) TypeSpecs
    // keyed by a stable function-type symbol identity. A FunctionTypeSymbol
    // is cached by its parameter/return symbol identities (see
    // FunctionTypeSymbol.Get) so reference-equality is sufficient.
    private readonly Dictionary<FunctionTypeSymbol, EntityHandle> functionDelegateTypeSpecCache =
        new Dictionary<FunctionTypeSymbol, EntityHandle>(ReferenceEqualityComparer.Instance);

    private readonly Dictionary<FunctionTypeSymbol, EntityHandle> functionDelegateCtorRefCache =
        new Dictionary<FunctionTypeSymbol, EntityHandle>(ReferenceEqualityComparer.Instance);

    private readonly Dictionary<FunctionTypeSymbol, EntityHandle> functionDelegateInvokeRefCache =
        new Dictionary<FunctionTypeSymbol, EntityHandle>(ReferenceEqualityComparer.Instance);

    /// <summary>
    /// ADR-0087 §3 R6: returns a <c>TypeSpec</c> EntityHandle for the
    /// reified <c>Func&lt;...&gt;</c> / <c>Action&lt;...&gt;</c> shape
    /// backing <paramref name="fnType"/>. Type-parameter arguments encode
    /// as <c>Var(idx)</c> / <c>MVar(idx)</c>.
    /// </summary>
    internal EntityHandle GetFunctionDelegateTypeSpec(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateTypeSpecCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var sigBlob = new BlobBuilder();
        this.signatures.EncodeFunctionTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), fnType);
        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateTypeSpecCache[fnType] = spec;
        return spec;
    }

    /// <summary>
    /// Issue #1330: returns the MemberRef handle for the canonical delegate
    /// <c>.ctor(object, IntPtr)</c> parented at the constructed-generic TypeSpec
    /// of <paramref name="symbolicDelegate"/> — a delegate type closed over an
    /// in-scope generic type parameter (e.g. <c>Comparison&lt;!TResult&gt;</c>).
    /// Lets a function literal passed to a static generic factory
    /// (<c>Comparer[TResult].Create(...)</c>) materialise the exact delegate the
    /// callee expects rather than the natural <c>Func</c>/<c>Action</c> shape or
    /// the type-erased <c>Comparison&lt;object&gt;</c>.
    /// </summary>
    internal EntityHandle GetConstructedDelegateCtorRef(ImportedTypeSymbol symbolicDelegate)
    {
        var parentBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), symbolicDelegate);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                2,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().Object();
                    ps.AddParameter().Type().IntPtr();
                });

        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// ADR-0087 §3 R6: returns the MemberRef handle for the reified
    /// delegate's <c>.ctor(object, IntPtr)</c>, parented at the
    /// <c>TypeSpec</c> for <paramref name="fnType"/>. Used by
    /// <c>EmitFunctionLiteral</c> / <c>EmitMethodGroup</c> when the
    /// function type contains type-parameter slots.
    /// </summary>
    internal EntityHandle GetFunctionDelegateCtorRef(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateCtorRefCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var parent = this.GetFunctionDelegateTypeSpec(fnType);

        // Every Func/Action delegate exposes the canonical
        // .ctor(object target, IntPtr methodPtr) signature; identical
        // for every arity so no Var/MVar slots are needed.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                2,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().Object();
                    ps.AddParameter().Type().IntPtr();
                });

        var handle = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateCtorRefCache[fnType] = handle;
        return handle;
    }

    /// <summary>
    /// ADR-0087 §3 R6: returns the MemberRef handle for the reified
    /// delegate's <c>Invoke</c> method, parented at the <c>TypeSpec</c>
    /// for <paramref name="fnType"/>. The signature uses <c>VAR(i)</c>
    /// slots referencing the delegate type's own class-generic
    /// parameters (e.g. <c>Func`2::Invoke</c> is encoded as
    /// <c>!0 Invoke(!0)</c> wait — actually
    /// <c>!1 Invoke(!0)</c>). When the runtime resolves this MemberRef
    /// through the constructed parent <c>TypeSpec</c> (e.g.
    /// <c>Func&lt;int32, int32&gt;</c>), the VAR slots get substituted
    /// to the concrete arguments. No <see cref="System.Delegate.DynamicInvoke"/>
    /// is required.
    /// </summary>
    internal EntityHandle GetFunctionDelegateInvokeRef(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateInvokeRefCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var parent = this.GetFunctionDelegateTypeSpec(fnType);

        bool isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType);
        int arity = fnType.ParameterTypes.Length;

        // The MemberRef signature for a method on a generic TypeSpec
        // parent must reference the parent type's *class-generic*
        // type parameters via VAR slots (`!0`..`!N-1`). The runtime
        // substitutes them against the parent's instantiation when
        // dispatching the call. For Func`N the slots are
        // `(!0,...,!N-1) -> !N`; for Action`N they are
        // `(!0,...,!N-1) -> void`.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                arity,
                returnType: r =>
                {
                    if (isVoid)
                    {
                        r.Void();
                    }
                    else
                    {
                        r.Type().GenericTypeParameter(arity);
                    }
                },
                parameters: ps =>
                {
                    for (int i = 0; i < arity; i++)
                    {
                        ps.AddParameter().Type().GenericTypeParameter(i);
                    }
                });

        var handle = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("Invoke"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateInvokeRefCache[fnType] = handle;
        return handle;
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
    internal EntityHandle? TryGetSymbolicAsyncDelegateCtorRef(FunctionTypeSymbol fnType, FunctionSymbol function)
    {
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
            return null;
        }

        var builderInfo = plan.StateMachine.BuilderInfo;

        // async void → Action shape (no Task<T> wrapping). Symbolic only when a
        // parameter is itself user-defined / type-parameter-bearing.
        if (builderInfo.Kind == AsyncMethodBuilderKind.Void)
        {
            var voidFn = FunctionTypeSymbol.Get(fnType.ParameterTypes, TypeSymbol.Void);
            return this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(voidFn)
                ? this.GetFunctionDelegateCtorRef(voidFn)
                : (EntityHandle?)null;
        }

        if (builderInfo.TaskProperty?.PropertyType is not Type taskClrType
            || plan.StateMachine.ResultTypeSymbol is not TypeSymbol resultSym)
        {
            return null;
        }

        TypeSymbol taskReturn = taskClrType.IsConstructedGenericType
            ? ImportedTypeSymbol.GetConstructed(
                taskClrType,
                taskClrType.GetGenericTypeDefinition(),
                ImmutableArray.Create(resultSym))
            : ImportedTypeSymbol.Get(taskClrType);

        var asyncFn = FunctionTypeSymbol.Get(fnType.ParameterTypes, taskReturn);
        return this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(asyncFn)
            ? this.GetFunctionDelegateCtorRef(asyncFn)
            : (EntityHandle?)null;
    }
}
