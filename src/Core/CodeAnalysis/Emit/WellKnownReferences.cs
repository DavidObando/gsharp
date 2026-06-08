// <copyright file="WellKnownReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Owns every well-known BCL <see cref="MemberReferenceHandle"/> /
/// <see cref="TypeReferenceHandle"/> that the
/// <see cref="ReflectionMetadataEmitter"/> threads through code generation —
/// <c>System.Object</c> / <c>System.ValueType</c> TypeRefs, the
/// <c>Object..ctor()</c> MemberRef, <c>String.Concat</c>, <c>String.Equals</c>,
/// <c>Object.Equals(object, object)</c>, <c>Object.ToString()</c>,
/// <c>Object.GetHashCode()</c>, the <c>System.HashCode</c> family
/// (<c>Combine</c>, <c>Add</c>, <c>ToHashCode</c>),
/// <c>Convert.ToString(object, IFormatProvider)</c>,
/// <c>CultureInfo.InvariantCulture</c>, <c>Delegate.Combine/Remove</c>,
/// <c>Interlocked.CompareExchange&lt;T&gt;</c>,
/// <c>NotImplementedException..ctor()</c>,
/// <c>NullReferenceException..ctor()</c>,
/// <c>System.Attribute..ctor()</c>, the
/// <c>IsReadOnlyAttribute</c> / <c>IsByRefLikeAttribute</c> /
/// <c>ObsoleteAttribute</c> ctors, and the stateless lookups for
/// <c>String.get_Length</c> / <c>String.get_Chars</c> /
/// <c>Type.GetTypeFromHandle</c> / <c>Array.Copy</c> /
/// <c>Nullable&lt;T&gt;.get_Value</c> / <c>Nullable&lt;T&gt;.get_HasValue</c>.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-3 extracts this type as the third step of the
/// <see cref="ReflectionMetadataEmitter"/> decomposition described in the
/// repository-level decomposition plan. The class consumes
/// <see cref="EmitContext"/> for <c>Metadata</c>/<c>References</c>/<c>Core*</c>
/// access and small <see cref="Func{T, TResult}"/> hooks for the
/// dedup-cached resolvers <c>GetTypeReference(Type)</c> and
/// <c>GetMethodReference(MethodInfo)</c> that still live on
/// <see cref="ReflectionMetadataEmitter"/> (and which themselves route
/// through <see cref="MetadataTokenCache"/>).
/// </para>
/// <para>
/// Eager refs (<see cref="ObjectTypeRef"/>, <see cref="ValueTypeRef"/>,
/// <see cref="ObjectCtorRef"/>) are populated by the constructor — the
/// emitter's <c>EmitCore</c> resolves the BCL <c>Core*</c> types onto
/// <see cref="EmitContext"/> first, then instantiates
/// <see cref="WellKnownReferences"/> exactly once. Every other ref is
/// lazy: the corresponding <c>Get*</c> method tests the backing field for
/// nil/HasValue and creates the row on first access. This preserves the
/// existing single-row-per-reference dedup behavior so the emitted IL stays
/// byte-identical with what the inline ReflectionMetadataEmitter
/// implementation produced before this PR.
/// </para>
/// </remarks>
internal sealed class WellKnownReferences
{
    private readonly EmitContext emitCtx;
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;
    private readonly Func<MethodInfo, MemberReferenceHandle> getMethodReference;
    private readonly MemberReferenceHandle?[] hashCodeCombineOpenRefs = new MemberReferenceHandle?[8];

    // ADR-0051 Phase 6: cached MemberReferenceHandle for NotImplementedException..ctor().
    private MemberReferenceHandle? notImplementedExceptionCtorRef;

    // ADR-0052: cached MemberReferenceHandles for Delegate.Combine and Delegate.Remove.
    private MemberReferenceHandle? delegateCombineRef;
    private MemberReferenceHandle? delegateRemoveRef;

    // Issue #256: cached open MemberRef for Interlocked.CompareExchange<T>(ref T, T, T).
    private MemberReferenceHandle? interlockedCompareExchangeOpenRef;

    // Issue #420 (P3-11): cached MemberRefs for IsReadOnlyAttribute/IsByRefLikeAttribute/ObsoleteAttribute ctors,
    // so repeated emission of these markers doesn't create duplicate MemberRef rows.
    private MemberReferenceHandle? isReadOnlyAttributeCtorRef;
    private MemberReferenceHandle? isByRefLikeAttributeCtorRef;
    private MemberReferenceHandle? obsoleteAttributeStringBoolCtorRef;

    // Issue #410 / ADR-0029: cached member refs for data-struct synthesized members.
    private MemberReferenceHandle stringConcatRef;
    private MemberReferenceHandle stringEqualsRef;
    private MemberReferenceHandle objectStaticEqualsRef;
    private MemberReferenceHandle objectInstanceToStringRef;
    private MemberReferenceHandle objectInstanceGetHashCodeRef;
    private MemberReferenceHandle nullRefExceptionCtorRef;
    private MemberReferenceHandle stringConcatArrayRef;
    private MemberReferenceHandle convertToStringRef;
    private MemberReferenceHandle cultureInvariantGetterRef;
    private MemberReferenceHandle hashCodeAddOpenRef;
    private MemberReferenceHandle hashCodeToHashCodeRef;
    private TypeReferenceHandle hashCodeTypeRef;

    private EntityHandle? systemAttributeTypeRef;
    private MemberReferenceHandle? systemAttributeCtorRef;

    /// <summary>
    /// Initializes a new instance of the <see cref="WellKnownReferences"/>
    /// class and eagerly resolves the three references the emitter needs
    /// before any TypeDef row is written: the <c>System.Object</c> TypeRef,
    /// the <c>System.ValueType</c> TypeRef, and the parameterless
    /// <c>Object..ctor()</c> MemberRef used as the base-class chain target
    /// for every synthesized default ctor.
    /// </summary>
    /// <param name="emitCtx">The cross-cutting emit context.</param>
    /// <param name="getTypeReference">
    /// Dedup-cached resolver for arbitrary CLR <see cref="Type"/> →
    /// <see cref="TypeReferenceHandle"/>. Lives on
    /// <see cref="ReflectionMetadataEmitter"/> because it routes through
    /// <see cref="MetadataTokenCache.TypeRefs"/> and recursively handles
    /// nested / coreLib-base / generic-instantiation cases.
    /// </param>
    /// <param name="getMethodReference">
    /// Dedup-cached resolver for arbitrary <see cref="MethodInfo"/> →
    /// <see cref="MemberReferenceHandle"/>. Lives on
    /// <see cref="ReflectionMetadataEmitter"/> because it encodes open
    /// generic method signatures using the same machinery as user-defined
    /// method emission.
    /// </param>
    public WellKnownReferences(
        EmitContext emitCtx,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<MethodInfo, MemberReferenceHandle> getMethodReference)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.getTypeReference = getTypeReference ?? throw new ArgumentNullException(nameof(getTypeReference));
        this.getMethodReference = getMethodReference ?? throw new ArgumentNullException(nameof(getMethodReference));

        // Eager init: previously lived inline in ReflectionMetadataEmitter.EmitCore
        // immediately after the Core* types were resolved onto EmitContext. Order
        // matters — ObjectCtorRef depends on ObjectTypeRef.
        this.ObjectTypeRef = this.getTypeReference(this.emitCtx.CoreObjectType);
        this.ValueTypeRef = this.getTypeReference(this.emitCtx.CoreValueType);
        this.ObjectCtorRef = this.BuildObjectDefaultCtorReference();
    }

    /// <summary>
    /// Gets the eager-resolved TypeRef for <c>System.Object</c>. Used as the
    /// base type for every emitted reference-type TypeDef and as the parent
    /// of <see cref="ObjectCtorRef"/>.
    /// </summary>
    public TypeReferenceHandle ObjectTypeRef { get; }

    /// <summary>
    /// Gets the eager-resolved TypeRef for <c>System.ValueType</c>. Used as
    /// the base type for every emitted value-type TypeDef (data structs,
    /// enums, ref structs, async/iterator state-machine structs).
    /// </summary>
    public TypeReferenceHandle ValueTypeRef { get; }

    /// <summary>
    /// Gets the eager-resolved MemberRef for the parameterless
    /// <c>System.Object..ctor()</c>. Used as the chain target for every
    /// synthesized default ctor on a reference-type TypeDef whose base class
    /// resolves to <see cref="object"/>.
    /// </summary>
    public MemberReferenceHandle ObjectCtorRef { get; }

    /// <summary>Resolves a MemberReferenceHandle for System.NotImplementedException..ctor().</summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetNotImplementedExceptionCtor()
    {
        if (this.notImplementedExceptionCtorRef.HasValue)
        {
            return this.notImplementedExceptionCtorRef.Value;
        }

        var nieType = typeof(System.NotImplementedException);
        var nieTypeRef = this.getTypeReference(nieType);
        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        this.notImplementedExceptionCtorRef = this.emitCtx.Metadata.AddMemberReference(
            nieTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));
        return this.notImplementedExceptionCtorRef.Value;
    }

    /// <summary>ADR-0052: resolves a MemberReferenceHandle for Delegate.Combine(Delegate, Delegate).</summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetDelegateCombineRef()
    {
        if (this.delegateCombineRef.HasValue)
        {
            return this.delegateCombineRef.Value;
        }

        var delegateTypeRef = this.getTypeReference(typeof(System.Delegate));
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Type(delegateTypeRef, isValueType: false),
                ps =>
                {
                    ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false);
                    ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false);
                });

        this.delegateCombineRef = this.emitCtx.Metadata.AddMemberReference(
            delegateTypeRef,
            this.emitCtx.Metadata.GetOrAddString("Combine"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        return this.delegateCombineRef.Value;
    }

    /// <summary>ADR-0052: resolves a MemberReferenceHandle for Delegate.Remove(Delegate, Delegate).</summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetDelegateRemoveRef()
    {
        if (this.delegateRemoveRef.HasValue)
        {
            return this.delegateRemoveRef.Value;
        }

        var delegateTypeRef = this.getTypeReference(typeof(System.Delegate));
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Type(delegateTypeRef, isValueType: false),
                ps =>
                {
                    ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false);
                    ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false);
                });

        this.delegateRemoveRef = this.emitCtx.Metadata.AddMemberReference(
            delegateTypeRef,
            this.emitCtx.Metadata.GetOrAddString("Remove"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        return this.delegateRemoveRef.Value;
    }

    /// <summary>
    /// Issue #256: resolves the open MemberRef for Interlocked.CompareExchange&lt;T&gt;(ref T, T, T).
    /// </summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetInterlockedCompareExchangeOpenRef()
    {
        if (this.interlockedCompareExchangeOpenRef.HasValue)
        {
            return this.interlockedCompareExchangeOpenRef.Value;
        }

        var interlockedTypeRef = this.getTypeReference(typeof(System.Threading.Interlocked));

        // Signature: static T CompareExchange<T>(ref T, T, T) with 1 generic param.
        // In open form, T is !!0 (method type parameter at index 0).
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false, genericParameterCount: 1)
            .Parameters(
                3,
                r => r.Type().GenericMethodTypeParameter(0),
                ps =>
                {
                    ps.AddParameter().Type(isByRef: true).GenericMethodTypeParameter(0);
                    ps.AddParameter().Type().GenericMethodTypeParameter(0);
                    ps.AddParameter().Type().GenericMethodTypeParameter(0);
                });

        this.interlockedCompareExchangeOpenRef = this.emitCtx.Metadata.AddMemberReference(
            interlockedTypeRef,
            this.emitCtx.Metadata.GetOrAddString("CompareExchange"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        return this.interlockedCompareExchangeOpenRef.Value;
    }

    /// <summary>
    /// ADR-0060 §6: returns the TypeRef handle for
    /// <c>System.Runtime.CompilerServices.IsReadOnlyAttribute</c>, used as the
    /// <c>modreq</c> on each emitted <c>in</c> parameter signature.
    /// </summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    /// <returns>The cached <see cref="EntityHandle"/>.</returns>
    /// <returns>The TypeRef entity handle, or <see langword="default"/> if the type can't be resolved.</returns>
    public EntityHandle GetIsReadOnlyAttributeTypeRef()
    {
        var attrType = this.emitCtx.References.TryResolveType("System.Runtime.CompilerServices.IsReadOnlyAttribute", out var resolved)
            ? resolved
            : typeof(System.Runtime.CompilerServices.IsReadOnlyAttribute);
        return this.getTypeReference(attrType);
    }

    public MemberReferenceHandle GetIsReadOnlyAttributeCtorRef()
    {
        if (this.isReadOnlyAttributeCtorRef.HasValue)
        {
            return this.isReadOnlyAttributeCtorRef.Value;
        }

        var attrType = this.emitCtx.References.TryResolveType("System.Runtime.CompilerServices.IsReadOnlyAttribute", out var resolved)
            ? resolved
            : typeof(System.Runtime.CompilerServices.IsReadOnlyAttribute);
        var attrTypeRef = this.getTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        this.isReadOnlyAttributeCtorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));
        return this.isReadOnlyAttributeCtorRef.Value;
    }

    public MemberReferenceHandle GetIsByRefLikeAttributeCtorRef()
    {
        if (this.isByRefLikeAttributeCtorRef.HasValue)
        {
            return this.isByRefLikeAttributeCtorRef.Value;
        }

        var attrType = this.emitCtx.References.TryResolveType("System.Runtime.CompilerServices.IsByRefLikeAttribute", out var resolved)
            ? resolved
            : typeof(System.Runtime.CompilerServices.IsByRefLikeAttribute);
        var attrTypeRef = this.getTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        this.isByRefLikeAttributeCtorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));
        return this.isByRefLikeAttributeCtorRef.Value;
    }

    public MemberReferenceHandle GetObsoleteAttributeStringBoolCtorRef()
    {
        if (this.obsoleteAttributeStringBoolCtorRef.HasValue)
        {
            return this.obsoleteAttributeStringBoolCtorRef.Value;
        }

        var obsoleteType = this.emitCtx.References.TryResolveType("System.ObsoleteAttribute", out var obsoleteResolved)
            ? obsoleteResolved
            : typeof(System.ObsoleteAttribute);
        var obsoleteTypeRef = this.getTypeReference(obsoleteType);

        var obsoleteCtorSig = new BlobBuilder();
        new BlobEncoder(obsoleteCtorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(2, r => r.Void(), p =>
            {
                p.AddParameter().Type().String();
                p.AddParameter().Type().Boolean();
            });

        this.obsoleteAttributeStringBoolCtorRef = this.emitCtx.Metadata.AddMemberReference(
            obsoleteTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(obsoleteCtorSig));
        return this.obsoleteAttributeStringBoolCtorRef.Value;
    }

    public EntityHandle GetSystemAttributeTypeRef()
    {
        if (!this.systemAttributeTypeRef.HasValue)
        {
            var t = this.emitCtx.References.TryResolveType("System.Attribute", out var resolved)
                ? resolved
                : typeof(System.Attribute);
            this.systemAttributeTypeRef = this.getTypeReference(t);
        }

        return this.systemAttributeTypeRef.Value;
    }

    public MemberReferenceHandle GetSystemAttributeCtorRef()
    {
        if (!this.systemAttributeCtorRef.HasValue)
        {
            var attrTypeRef = this.GetSystemAttributeTypeRef();
            var ctorSig = new BlobBuilder();
            new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
                .Parameters(0, r => r.Void(), _ => { });

            this.systemAttributeCtorRef = this.emitCtx.Metadata.AddMemberReference(
                attrTypeRef,
                this.emitCtx.Metadata.GetOrAddString(".ctor"),
                this.emitCtx.Metadata.GetOrAddBlob(ctorSig));
        }

        return this.systemAttributeCtorRef.Value;
    }

    public MemberReferenceHandle GetNullReferenceExceptionCtorRef()
    {
        // System.NullReferenceException::.ctor() — used to back the `!!`
        // operator's runtime check when its operand is null.
        if (!this.nullRefExceptionCtorRef.IsNil)
        {
            return this.nullRefExceptionCtorRef;
        }

        var nreType = this.emitCtx.References.TryResolveType("System.NullReferenceException", out var resolved)
            ? resolved
            : typeof(NullReferenceException);
        var nreTypeRef = this.getTypeReference(nreType);
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        this.nullRefExceptionCtorRef = this.emitCtx.Metadata.AddMemberReference(
            parent: nreTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return this.nullRefExceptionCtorRef;
    }

    // Issue #504: returns a callable MemberRef for `System.Nullable<T>::get_Value`
    // closed over the supplied value-type underlying CLR type. Used by `!!` emit
    // to unwrap a `Nullable<T>` operand (throws `InvalidOperationException` at
    // runtime when `HasValue` is false, matching the BCL property).
    public MemberReferenceHandle GetNullableGetValueReference(Type underlyingValueType)
    {
        if (underlyingValueType == null || !underlyingValueType.IsValueType)
        {
            throw new InvalidOperationException(
                $"GetNullableGetValueReference: '{underlyingValueType?.FullName}' is not a value type.");
        }

        // Issue #571: route Nullable<T> construction through the
        // ReferenceResolver so the open `System.Nullable`1` definition and the
        // (possibly MLC-backed) inner value type share a load context. Building
        // it from host `typeof(System.Nullable<>)` here would yield a
        // get_Value MethodInfo whose declaring type mixes contexts, which then
        // fails as GS9998 inside the MemberRef encoding path.
        if (!NullableLifting.TryConstructNullable(this.emitCtx.References, underlyingValueType, out var nullableClr))
        {
            throw new InvalidOperationException(
                $"Cannot construct Nullable<{underlyingValueType.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
        }

        var getValue = nullableClr.GetMethod("get_Value", Type.EmptyTypes)
            ?? throw new InvalidOperationException(
                $"System.Nullable<{underlyingValueType.FullName}>::get_Value() is not resolvable.");
        return this.getMethodReference(getValue);
    }

    // Issue #519: returns a callable MemberRef for `System.Nullable<T>::get_HasValue`
    // closed over the supplied value-type underlying CLR type. Used by `?:` emit
    // on a value-type `Nullable<T>` operand to branch on the presence flag without
    // box/dup tricks (which are illegal on a struct stack value).
    public MemberReferenceHandle GetNullableGetHasValueReference(Type underlyingValueType)
    {
        if (underlyingValueType == null || !underlyingValueType.IsValueType)
        {
            throw new InvalidOperationException(
                $"GetNullableGetHasValueReference: '{underlyingValueType?.FullName}' is not a value type.");
        }

        // Issue #571: see GetNullableGetValueReference for rationale.
        if (!NullableLifting.TryConstructNullable(this.emitCtx.References, underlyingValueType, out var nullableClr))
        {
            throw new InvalidOperationException(
                $"Cannot construct Nullable<{underlyingValueType.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
        }

        var getHasValue = nullableClr.GetMethod("get_HasValue", Type.EmptyTypes)
            ?? throw new InvalidOperationException(
                $"System.Nullable<{underlyingValueType.FullName}>::get_HasValue() is not resolvable.");
        return this.getMethodReference(getHasValue);
    }

    public MemberReferenceHandle GetStringLengthReference()
    {
        // System.String::get_Length() — used to implement len(string).
        var method = this.emitCtx.CoreStringType.GetMethod("get_Length", Type.EmptyTypes)
            ?? throw new InvalidOperationException("String.get_Length is not resolvable from the supplied references.");
        return this.getMethodReference(method);
    }

    public MemberReferenceHandle GetStringCharsReference()
    {
        // System.String::get_Chars(Int32) — used for string indexing (issue #537).
        var method = this.emitCtx.CoreStringType.GetMethod("get_Chars", new[] { typeof(int) })
            ?? throw new InvalidOperationException("String.get_Chars(int) is not resolvable from the supplied references.");
        return this.getMethodReference(method);
    }

    public MemberReferenceHandle GetTypeFromHandleReference()
    {
        // System.Type::GetTypeFromHandle(RuntimeTypeHandle) — backs `typeof(T)`.
        var method = this.emitCtx.CoreSystemType.GetMethod(
            "GetTypeFromHandle",
            new[] { this.emitCtx.CoreRuntimeTypeHandleType })
            ?? throw new InvalidOperationException("Type.GetTypeFromHandle(RuntimeTypeHandle) is not resolvable from the supplied references.");
        return this.getMethodReference(method);
    }

    public MemberReferenceHandle GetArrayCopyReference()
    {
        // System.Array::Copy(Array, Array, Int32) — used to implement append(slice, element).
        var method = this.emitCtx.CoreArrayType.GetMethod(
            "Copy",
            new[] { this.emitCtx.CoreArrayType, this.emitCtx.CoreArrayType, this.emitCtx.CoreInt32Type })
            ?? throw new InvalidOperationException("Array.Copy(Array, Array, int) is not resolvable from the supplied references.");
        return this.getMethodReference(method);
    }

    public MemberReferenceHandle GetStringConcatReference()
    {
        if (!this.stringConcatRef.IsNil)
        {
            return this.stringConcatRef;
        }

        var stringTypeRef = this.getTypeReference(this.emitCtx.CoreStringType);
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().String(),
                ps =>
                {
                    ps.AddParameter().Type().String();
                    ps.AddParameter().Type().String();
                });
        this.stringConcatRef = this.emitCtx.Metadata.AddMemberReference(
            parent: stringTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("Concat"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return this.stringConcatRef;
    }

    public MemberReferenceHandle GetStringEqualsReference()
    {
        if (!this.stringEqualsRef.IsNil)
        {
            return this.stringEqualsRef;
        }

        var stringTypeRef = this.getTypeReference(this.emitCtx.CoreStringType);
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Boolean(),
                ps =>
                {
                    ps.AddParameter().Type().String();
                    ps.AddParameter().Type().String();
                });
        this.stringEqualsRef = this.emitCtx.Metadata.AddMemberReference(
            parent: stringTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("Equals"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return this.stringEqualsRef;
    }

    public MemberReferenceHandle GetObjectInstanceToStringReference()
    {
        if (!this.objectInstanceToStringRef.IsNil)
        {
            return this.objectInstanceToStringRef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Type().String(), _ => { });
        this.objectInstanceToStringRef = this.emitCtx.Metadata.AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("ToString"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return this.objectInstanceToStringRef;
    }

    public MemberReferenceHandle GetObjectInstanceGetHashCodeReference()
    {
        if (!this.objectInstanceGetHashCodeRef.IsNil)
        {
            return this.objectInstanceGetHashCodeRef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Type().Int32(), _ => { });
        this.objectInstanceGetHashCodeRef = this.emitCtx.Metadata.AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("GetHashCode"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return this.objectInstanceGetHashCodeRef;
    }

    /// <summary>
    /// Returns a MemberRef for static <c>bool System.Object.Equals(object, object)</c>.
    /// Used by Phase 3.B.2 data-struct <c>==</c> / <c>!=</c> lowering: we box
    /// the operand values and call this static helper, which routes through
    /// the virtual <c>ValueType.Equals(object)</c> override (reflection-based
    /// field-by-field comparison) for user value types. Same observable
    /// semantics as the interpreter's structural equality (ADR-0029); a
    /// future iteration may replace this with a direct synthesized
    /// <c>Equals(T)</c> method for performance.
    /// </summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetObjectStaticEqualsReference()
    {
        if (!this.objectStaticEqualsRef.IsNil)
        {
            return this.objectStaticEqualsRef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Boolean(),
                ps =>
                {
                    ps.AddParameter().Type().Object();
                    ps.AddParameter().Type().Object();
                });
        this.objectStaticEqualsRef = this.emitCtx.Metadata.AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("Equals"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return this.objectStaticEqualsRef;
    }

    /// <summary>
    /// Issue #410 / ADR-0029: returns a TypeRef for <c>System.HashCode</c>,
    /// used by data-struct <c>GetHashCode</c> synthesis. Cached because the
    /// data-struct helpers need a strongly-typed handle even though the
    /// underlying <see cref="MetadataTokenCache.TypeRefs"/> dedups by
    /// <see cref="Type"/>.
    /// </summary>
    /// <returns>The cached <see cref="TypeReferenceHandle"/>.</returns>
    public TypeReferenceHandle GetHashCodeTypeReference()
    {
        if (!this.hashCodeTypeRef.IsNil)
        {
            return this.hashCodeTypeRef;
        }

        this.hashCodeTypeRef = this.getTypeReference(typeof(System.HashCode));
        return this.hashCodeTypeRef;
    }

    /// <summary>
    /// Issue #410 / ADR-0029: resolves an open MemberRef for the
    /// <c>System.HashCode.Combine&lt;T1, ..., Tn&gt;</c> overload with the
    /// given arity (1 ≤ <paramref name="arity"/> ≤ 8). Each open parameter
    /// is encoded as a generic method parameter (<c>!!i</c>) and instantiated
    /// to <see cref="object"/> via a MethodSpec at the call site.
    /// </summary>
    /// <param name="arity">The number of generic parameters (1–8) on the desired <c>HashCode.Combine</c> overload.</param>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetHashCodeCombineOpenReference(int arity)
    {
        if (arity < 1 || arity > 8)
        {
            throw new ArgumentOutOfRangeException(nameof(arity), arity, "HashCode.Combine supports arities 1 through 8.");
        }

        var cached = this.hashCodeCombineOpenRefs[arity - 1];
        if (cached.HasValue)
        {
            return cached.Value;
        }

        var hashCodeRef = this.GetHashCodeTypeReference();

        // Signature: static int Combine<T1,...,Tn>(T1, ..., Tn) with `arity`
        // generic method parameters. In open form each Ti is !!i.
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false, genericParameterCount: arity)
            .Parameters(
                arity,
                r => r.Type().Int32(),
                ps =>
                {
                    for (int i = 0; i < arity; i++)
                    {
                        ps.AddParameter().Type().GenericMethodTypeParameter(i);
                    }
                });

        var openRef = this.emitCtx.Metadata.AddMemberReference(
            hashCodeRef,
            this.emitCtx.Metadata.GetOrAddString("Combine"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        this.hashCodeCombineOpenRefs[arity - 1] = openRef;
        return openRef;
    }

    /// <summary>
    /// Issue #410 / ADR-0029: resolves the open MemberRef for the instance
    /// method <c>System.HashCode.Add&lt;T&gt;(T)</c>, used by the &gt;8-field
    /// fold path for <c>GetHashCode</c>.
    /// </summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetHashCodeAddOpenReference()
    {
        if (!this.hashCodeAddOpenRef.IsNil)
        {
            return this.hashCodeAddOpenRef;
        }

        var hashCodeRef = this.GetHashCodeTypeReference();

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true, genericParameterCount: 1)
            .Parameters(
                1,
                r => r.Void(),
                ps => ps.AddParameter().Type().GenericMethodTypeParameter(0));

        this.hashCodeAddOpenRef = this.emitCtx.Metadata.AddMemberReference(
            hashCodeRef,
            this.emitCtx.Metadata.GetOrAddString("Add"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        return this.hashCodeAddOpenRef;
    }

    /// <summary>
    /// Issue #410 / ADR-0029: resolves the MemberRef for instance method
    /// <c>System.HashCode.ToHashCode()</c>.
    /// </summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetHashCodeToHashCodeReference()
    {
        if (!this.hashCodeToHashCodeRef.IsNil)
        {
            return this.hashCodeToHashCodeRef;
        }

        var hashCodeRef = this.GetHashCodeTypeReference();

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Type().Int32(), _ => { });

        this.hashCodeToHashCodeRef = this.emitCtx.Metadata.AddMemberReference(
            hashCodeRef,
            this.emitCtx.Metadata.GetOrAddString("ToHashCode"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        return this.hashCodeToHashCodeRef;
    }

    /// <summary>
    /// Issue #410 / ADR-0029: resolves the MemberRef for the static
    /// <c>System.Convert.ToString(object, IFormatProvider)</c> overload used
    /// by data-struct <c>ToString</c> synthesis. Handles null reference-type
    /// fields gracefully (returns the empty string) per the ADR.
    /// </summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetConvertToStringReference()
    {
        if (!this.convertToStringRef.IsNil)
        {
            return this.convertToStringRef;
        }

        var convertRef = this.getTypeReference(typeof(System.Convert));
        var ifpRef = this.getTypeReference(typeof(System.IFormatProvider));

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().String(),
                ps =>
                {
                    ps.AddParameter().Type().Object();
                    ps.AddParameter().Type().Type(ifpRef, isValueType: false);
                });

        this.convertToStringRef = this.emitCtx.Metadata.AddMemberReference(
            convertRef,
            this.emitCtx.Metadata.GetOrAddString("ToString"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        return this.convertToStringRef;
    }

    /// <summary>
    /// Issue #410 / ADR-0029: resolves the MemberRef for the static
    /// property getter <c>System.Globalization.CultureInfo::get_InvariantCulture</c>,
    /// used to thread an invariant <see cref="System.IFormatProvider"/> into
    /// <c>Convert.ToString</c> during data-struct <c>ToString</c> synthesis.
    /// </summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetCultureInvariantGetterReference()
    {
        if (!this.cultureInvariantGetterRef.IsNil)
        {
            return this.cultureInvariantGetterRef;
        }

        var cultureInfoRef = this.getTypeReference(typeof(System.Globalization.CultureInfo));

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(0, r => r.Type().Type(cultureInfoRef, isValueType: false), _ => { });

        this.cultureInvariantGetterRef = this.emitCtx.Metadata.AddMemberReference(
            cultureInfoRef,
            this.emitCtx.Metadata.GetOrAddString("get_InvariantCulture"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        return this.cultureInvariantGetterRef;
    }

    /// <summary>
    /// Issue #410 / ADR-0029: resolves the MemberRef for the static
    /// <c>System.String.Concat(string[])</c> overload used to assemble the
    /// data-struct <c>ToString</c> output from a per-field array of pieces.
    /// </summary>
    /// <returns>The cached <see cref="MemberReferenceHandle"/>.</returns>
    public MemberReferenceHandle GetStringConcatArrayReference()
    {
        if (!this.stringConcatArrayRef.IsNil)
        {
            return this.stringConcatArrayRef;
        }

        var stringTypeRef = this.getTypeReference(this.emitCtx.CoreStringType);
        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(
                1,
                r => r.Type().String(),
                ps => ps.AddParameter().Type().SZArray().String());

        this.stringConcatArrayRef = this.emitCtx.Metadata.AddMemberReference(
            stringTypeRef,
            this.emitCtx.Metadata.GetOrAddString("Concat"),
            this.emitCtx.Metadata.GetOrAddBlob(sig));
        return this.stringConcatArrayRef;
    }

    private MemberReferenceHandle BuildObjectDefaultCtorReference()
    {
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        return this.emitCtx.Metadata.AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }
}
