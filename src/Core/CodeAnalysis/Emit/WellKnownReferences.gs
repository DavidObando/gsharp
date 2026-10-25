// <copyright file="WellKnownReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import System.Text
import System.Threading

/// Owns every well-known BCL (cref:MemberReferenceHandle) /
/// (cref:TypeReferenceHandle) that the
/// (cref:ReflectionMetadataEmitter) threads through code generation —
/// `System.Object` / `System.ValueType` TypeRefs, the
/// `Object..ctor()` MemberRef, `String.Concat`, `String.Equals`,
/// `Object.Equals(object, object)`, `Object.ToString()`,
/// `Object.GetHashCode()`, the `System.HashCode` family
/// (`Combine`, `Add`, `ToHashCode`),
/// `Convert.ToString(object, IFormatProvider)`,
/// `CultureInfo.InvariantCulture`, `Delegate.Combine/Remove`,
/// `Interlocked.CompareExchange<T>`,
/// `NotImplementedException..ctor()`,
/// `NullReferenceException..ctor()`,
/// `System.Attribute..ctor()`, the
/// `IsReadOnlyAttribute` / `IsByRefLikeAttribute` /
/// `ObsoleteAttribute` ctors, and the stateless lookups for
/// `String.get_Length` / `String.get_Chars` /
/// `Type.GetTypeFromHandle` / `Array.get_Length` / `Array.Copy` /
/// `Nullable<T>.get_Value` / `Nullable<T>.get_HasValue`.
/// @remarks PR-E-3 extracts this type as the third step of the
/// (cref:ReflectionMetadataEmitter) decomposition described in the
/// repository-level decomposition plan. The class consumes
/// (cref:EmitContext) for `Metadata`/`References`/`Core*`
/// access and small (cref:Func{T, TResult}) hooks for the
/// dedup-cached resolvers `GetTypeReference(Type)` and
/// `GetMethodReference(MethodInfo)` that still live on
/// (cref:ReflectionMetadataEmitter) (and which themselves route
/// through (cref:MetadataTokenCache)).
///
/// Eager refs ((cref:ObjectTypeRef), (cref:ValueTypeRef),
/// (cref:ObjectCtorRef)) are populated by the constructor — the
/// emitter's `EmitCore` resolves the BCL `Core*` types onto
/// (cref:EmitContext) first, then instantiates
/// (cref:WellKnownReferences) exactly once. Every other ref is
/// lazy: the corresponding `Get*` method tests the backing field for
/// nil/HasValue and creates the row on first access. This preserves the
/// existing single-row-per-reference dedup behavior so the emitted IL stays
/// byte-identical with what the inline ReflectionMetadataEmitter
/// implementation produced before this PR.
internal class WellKnownReferences {
    private let emitCtx EmitContext
    private let getTypeReference(Type) -> TypeReferenceHandle
    private let getMethodReference(MethodInfo) -> MemberReferenceHandle
    private let tokenCache MetadataTokenCache?
    private let hashCodeCombineOpenRefs[]MemberReferenceHandle? = [8]MemberReferenceHandle?

    // ADR-0051 Phase 6: cached MemberReferenceHandle for NotImplementedException..ctor().
    private var notImplementedExceptionCtorRef MemberReferenceHandle?

    // ADR-0052: cached MemberReferenceHandles for Delegate.Combine and Delegate.Remove.
    private var delegateCombineRef MemberReferenceHandle?

    private var delegateRemoveRef MemberReferenceHandle?

    // Issue #256: cached open MemberRef for Interlocked.CompareExchange<T>(ref T, T, T).
    private var interlockedCompareExchangeOpenRef MemberReferenceHandle?

    // Issue #420 (P3-11): cached MemberRefs for IsReadOnlyAttribute/IsByRefLikeAttribute/ObsoleteAttribute ctors,
    // so repeated emission of these markers doesn't create duplicate MemberRef rows.
    private var isReadOnlyAttributeCtorRef MemberReferenceHandle?

    private var isByRefLikeAttributeCtorRef MemberReferenceHandle?
    private var obsoleteAttributeStringBoolCtorRef MemberReferenceHandle?

    // ADR-0101 / issue #799: cached MemberRef for the parameterless
    // System.ParamArrayAttribute ctor. Stamped on every G#-authored
    // variadic parameter so C#/F# consumers see the parameter as `params`
    // at the call site and expand argument lists accordingly.
    private var paramArrayAttributeCtorRef MemberReferenceHandle?

    // Issue #792 / ADR-0084: cached MemberRef for the parameterless
    // System.Runtime.CompilerServices.ExtensionAttribute ctor. Used to mark
    // every G#-authored extension method (and its host TypeDef) so C#/F#
    // consumers see them as extension methods at the call site rather than
    // as plain static helpers on `<Program>`.
    private var extensionAttributeCtorRef MemberReferenceHandle?

    private var suspendingAttributeCtorRef MemberReferenceHandle?
    private var compilerGeneratedAttributeCtorRef MemberReferenceHandle?
    private var asyncStateMachineAttributeCtorRef MemberReferenceHandle?
    private var debuggerStepThroughAttributeCtorRef MemberReferenceHandle?
    private var preserveBaseOverridesAttributeCtorRef MemberReferenceHandle?
    private var unsafeValueTypeAttributeCtorRef MemberReferenceHandle?
    private var fixedBufferAttributeCtorRef MemberReferenceHandle?

    // Issue #834: cached MemberRefs for the two
    // System.Runtime.CompilerServices.NullableAttribute ctors and the
    // single-byte System.Runtime.CompilerServices.NullableContextAttribute
    // ctor. Stamped on per-parameter / per-return Param rows and on the
    // MethodDef itself so C# nullable-flow analysis treats `T?` reference
    // parameters as annotated instead of inferring the assembly default.
    private var nullableAttributeByteCtorRef EntityHandle?

    private var tupleElementNamesAttributeCtorRef MemberReferenceHandle?
    private var paramCollectionAttributeCtorRef MemberReferenceHandle?
    private var nullableAttributeByteArrayCtorRef EntityHandle?
    private var nullableContextAttributeByteCtorRef EntityHandle?

    // Issue #410 / ADR-0029: cached member refs for data-struct synthesized members.
    private var stringConcatRef MemberReferenceHandle

    private var stringEqualsRef MemberReferenceHandle
    private var objectStaticEqualsRef MemberReferenceHandle
    private var objectInstanceToStringRef MemberReferenceHandle
    private var objectInstanceGetHashCodeRef MemberReferenceHandle
    private var nullRefExceptionCtorRef MemberReferenceHandle
    private var nullRefExceptionMessageCtorRef MemberReferenceHandle
    private var stringBuilderTypeRef TypeReferenceHandle
    private var stringBuilderCtorRef MemberReferenceHandle
    private var stringBuilderAppendStringRef MemberReferenceHandle
    private var stringBuilderAppendObjectRef MemberReferenceHandle
    private var stringBuilderToStringRef MemberReferenceHandle
    private var hashCodeAddOpenRef MemberReferenceHandle
    private var hashCodeToHashCodeRef MemberReferenceHandle
    private var hashCodeTypeRef TypeReferenceHandle
    private var systemAttributeTypeRef EntityHandle?
    private var systemAttributeCtorRef MemberReferenceHandle?

    // ADR-0068 / issue #698: cached MemberRef for System.Object::Finalize().
    // Used to chain `base.Finalize()` from each user-declared deinit method.
    private var objectFinalizeRef MemberReferenceHandle?

    /// Initializes a new instance of the (cref:WellKnownReferences)
    /// class and eagerly resolves the three references the emitter needs
    /// before any TypeDef row is written: the `System.Object` TypeRef,
    /// the `System.ValueType` TypeRef, and the parameterless
    /// `Object..ctor()` MemberRef used as the base-class chain target
    /// for every synthesized default ctor.
    /// @param emitCtx The cross-cutting emit context.
    /// @param getTypeReference Dedup-cached resolver for arbitrary CLR (cref:Type) →
    /// (cref:TypeReferenceHandle). Lives on
    /// (cref:ReflectionMetadataEmitter) because it routes through
    /// (cref:MetadataTokenCache.TypeRefs) and recursively handles
    /// nested / coreLib-base / generic-instantiation cases.
    /// @param getMethodReference Dedup-cached resolver for arbitrary (cref:MethodInfo) →
    /// (cref:MemberReferenceHandle). Lives on
    /// (cref:ReflectionMetadataEmitter) because it encodes open
    /// generic method signatures using the same machinery as user-defined
    /// method emission.
    init(
        emitCtx EmitContext,
        getTypeReference(Type) -> TypeReferenceHandle,
        getMethodReference(MethodInfo) -> MemberReferenceHandle,
        tokenCache MetadataTokenCache? = nil
    ) {
        this.tokenCache = tokenCache
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.getTypeReference = getTypeReference ?? throw ArgumentNullException("getTypeReference")
        this.getMethodReference = getMethodReference ?? throw ArgumentNullException("getMethodReference")
        // Eager init: previously lived inline in ReflectionMetadataEmitter.EmitCore
        // immediately after the Core* types were resolved onto EmitContext. Order
        // matters — ObjectCtorRef depends on ObjectTypeRef.
        this.ObjectTypeRef = this.getTypeReference(this.emitCtx.CoreObjectType)
        this.ValueTypeRef = this.getTypeReference(this.emitCtx.CoreValueType)
        this.ObjectCtorRef = this.BuildObjectDefaultCtorReference()
    }

    /// Gets the eager-resolved TypeRef for `System.Object`. Used as the
    /// base type for every emitted reference-type TypeDef and as the parent
    /// of (cref:ObjectCtorRef).
    prop ObjectTypeRef TypeReferenceHandle {
        get;
    }

    /// Gets the eager-resolved TypeRef for `System.ValueType`. Used as
    /// the base type for every emitted value-type TypeDef (data structs,
    /// enums, ref structs, async/iterator state-machine structs).
    prop ValueTypeRef TypeReferenceHandle {
        get;
    }

    /// Gets the eager-resolved MemberRef for the parameterless
    /// `System.Object..ctor()`. Used as the chain target for every
    /// synthesized default ctor on a reference-type TypeDef whose base class
    /// resolves to (cref:object).
    prop ObjectCtorRef MemberReferenceHandle {
        get;
    }

    /// Resolves a MemberReferenceHandle for System.NotImplementedException..ctor().
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetNotImplementedExceptionCtor() MemberReferenceHandle {
        if (this.notImplementedExceptionCtorRef != nil) {
            return this.notImplementedExceptionCtorRef!!
        }
        let nieType = typeof(NotImplementedException)
        let nieTypeRef = this.getTypeReference(nieType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.notImplementedExceptionCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            nieTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.notImplementedExceptionCtorRef!!
    }

    /// ADR-0052: resolves a MemberReferenceHandle for Delegate.Combine(Delegate, Delegate).
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetDelegateCombineRef() MemberReferenceHandle {
        if (this.delegateCombineRef != nil) {
            return this.delegateCombineRef!!
        }
        let delegateTypeRef = this.getTypeReference(typeof(Delegate))
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: false).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Type().Type(delegateTypeRef, isValueType: false),
            (ps ParametersEncoder) -> {
                ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false)
                ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false)
            }
        )
        this.delegateCombineRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            delegateTypeRef,
            this.emitCtx.Metadata.GetOrAddString("Combine"),
            this.emitCtx.Metadata.GetOrAddBlob(sig)
        )
        return this.delegateCombineRef!!
    }

    /// ADR-0052: resolves a MemberReferenceHandle for Delegate.Remove(Delegate, Delegate).
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetDelegateRemoveRef() MemberReferenceHandle {
        if (this.delegateRemoveRef != nil) {
            return this.delegateRemoveRef!!
        }
        let delegateTypeRef = this.getTypeReference(typeof(Delegate))
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: false).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Type().Type(delegateTypeRef, isValueType: false),
            (ps ParametersEncoder) -> {
                ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false)
                ps.AddParameter().Type().Type(delegateTypeRef, isValueType: false)
            }
        )
        this.delegateRemoveRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            delegateTypeRef,
            this.emitCtx.Metadata.GetOrAddString("Remove"),
            this.emitCtx.Metadata.GetOrAddBlob(sig)
        )
        return this.delegateRemoveRef!!
    }

    /// Issue #256: resolves the open MemberRef for Interlocked.CompareExchange<T>(ref T, T, T).
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetInterlockedCompareExchangeOpenRef() MemberReferenceHandle {
        if (this.interlockedCompareExchangeOpenRef != nil) {
            return this.interlockedCompareExchangeOpenRef!!
        }
        let interlockedTypeRef = this.getTypeReference(typeof(Interlocked))
        // Signature: static T CompareExchange<T>(ref T, T, T) with 1 generic param.
        // In open form, T is !!0 (method type parameter at index 0).
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: false, genericParameterCount: 1).Parameters(
            3,
            (r ReturnTypeEncoder) -> r.Type().GenericMethodTypeParameter(0),
            (ps ParametersEncoder) -> {
                ps.AddParameter().Type(isByRef: true).GenericMethodTypeParameter(0)
                ps.AddParameter().Type().GenericMethodTypeParameter(0)
                ps.AddParameter().Type().GenericMethodTypeParameter(0)
            }
        )
        this.interlockedCompareExchangeOpenRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            interlockedTypeRef,
            this.emitCtx.Metadata.GetOrAddString("CompareExchange"),
            this.emitCtx.Metadata.GetOrAddBlob(sig)
        )
        return this.interlockedCompareExchangeOpenRef!!
    }

    /// ADR-0060 §6: returns the TypeRef handle for
    /// `System.Runtime.CompilerServices.IsReadOnlyAttribute`, used as the
    /// `modreq` on each emitted `in` parameter signature.
    /// @returns The cached (cref:MemberReferenceHandle).
    /// @returns The cached (cref:EntityHandle).
    /// @returns The TypeRef entity handle, or `default` if the type can't be resolved.
    func GetIsReadOnlyAttributeTypeRef() EntityHandle {
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.IsReadOnlyAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(IsReadOnlyAttribute)
        }
        return this.getTypeReference(attrType)
    }

    func GetInAttributeTypeRef() EntityHandle {
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.InteropServices.InAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(InAttribute)
        }
        return this.getTypeReference(attrType)
    }

    /// Issue #946: returns the TypeRef handle for
    /// `System.Runtime.CompilerServices.IsExternalInit`, used as the
    /// `modreq` on the void return of an `init`-only property setter
    /// (mirroring the C# 9 init-only setter encoding). Resolved against the
    /// target framework's reference assemblies (every runtime G# targets ships
    /// this type since .NET 5), falling back to the host runtime's type.
    /// @returns The TypeRef entity handle.
    func GetIsExternalInitTypeRef() EntityHandle {
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.IsExternalInit",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(IsExternalInit)
        }
        return this.getTypeReference(attrType)
    }

    func GetIsReadOnlyAttributeCtorRef() MemberReferenceHandle {
        if (this.isReadOnlyAttributeCtorRef != nil) {
            return this.isReadOnlyAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.IsReadOnlyAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(IsReadOnlyAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.isReadOnlyAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.isReadOnlyAttributeCtorRef!!
    }

    /// ADR-0101 / issue #799: returns the cached MemberRef for the
    /// parameterless `System.ParamArrayAttribute` constructor. Stamped
    /// on every G#-authored variadic parameter so the resulting metadata
    /// reads as a C# `params` array — C# / F# consumers expand
    /// argument lists at the call site as they would for any other
    /// params method.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetParamArrayAttributeCtorRef() MemberReferenceHandle {
        if (this.paramArrayAttributeCtorRef != nil) {
            return this.paramArrayAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType("System.ParamArrayAttribute", requireExternalVisibility: false, out var resolved) {
            resolved!!
        } else {
            typeof(ParamArrayAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.paramArrayAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.paramArrayAttributeCtorRef!!
    }

    func GetIsByRefLikeAttributeCtorRef() MemberReferenceHandle {
        if (this.isByRefLikeAttributeCtorRef != nil) {
            return this.isByRefLikeAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.IsByRefLikeAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(IsByRefLikeAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.isByRefLikeAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.isByRefLikeAttributeCtorRef!!
    }

    /// Issue #792 / ADR-0084. Returns the cached MemberRef for the
    /// parameterless constructor of
    /// `System.Runtime.CompilerServices.ExtensionAttribute`. The
    /// attribute is stamped on every extension MethodDef and on the
    /// extension method's host TypeDef so C#/F# call-site lookup treats the
    /// methods as extension methods at the call site (per ECMA-334 §13.6.9).
    ///
    /// ADR-0174 D4: the parameterless constructor of `Gsharp.Concurrency.SuspendingAttribute`, or `default`
    /// when the runtime is not referenced.
    /// @returns The cached (cref:MemberReferenceHandle), or
    /// `default` when the attribute type cannot be resolved
    /// from the reference closure (very old TFMs).
    /// @returns The MemberRef, or `default`.
    func GetSuspendingAttributeCtorRef() MemberReferenceHandle {
        if (this.suspendingAttributeCtorRef != nil) {
            return this.suspendingAttributeCtorRef!!
        }
        if !this
            .emitCtx
            .References
            .TryResolveType(
            "Gsharp.Concurrency.SuspendingAttribute",
            requireExternalVisibility: false,
            out var attrType
        ) ||
            attrType == nil {
            this.suspendingAttributeCtorRef = default(MemberReferenceHandle)
            return default(MemberReferenceHandle)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.suspendingAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.suspendingAttributeCtorRef!!
    }

    func GetExtensionAttributeCtorRef() MemberReferenceHandle {
        if (this.extensionAttributeCtorRef != nil) {
            return this.extensionAttributeCtorRef!!
        }
        let attrType Type? = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.ExtensionAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved
        } else {
            typeof(ExtensionAttribute)
        }
        if attrType == nil {
            return default(MemberReferenceHandle)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.extensionAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.extensionAttributeCtorRef!!
    }

    /// ADR-0174 P3-8: `[System.Runtime.CompilerServices.AsyncStateMachine(Type)]`,
    /// stamped on every async / suspending kickoff so the runtime's
    /// `StackTrace` and debuggers map a `MoveNext` frame back to
    /// the logical function.
    /// @returns The `.ctor(System.Type)` MemberRef.
    func GetAsyncStateMachineAttributeCtorRef() MemberReferenceHandle {
        if (this.asyncStateMachineAttributeCtorRef != nil) {
            return this.asyncStateMachineAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.AsyncStateMachineAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(AsyncStateMachineAttribute)
        }
        let systemType = if this
            .emitCtx
            .References
            .TryResolveType("System.Type", requireExternalVisibility: false, out var resolvedSystemType) {
            resolvedSystemType!!
        } else {
            typeof(Type)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let systemTypeRef = this.getTypeReference(systemType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> p.AddParameter().Type().Type(systemTypeRef, isValueType: false)
        )
        this.asyncStateMachineAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.asyncStateMachineAttributeCtorRef!!
    }

    /// ADR-0174 P3-8: `[System.Diagnostics.DebuggerStepThrough]` for the
    /// kickoff stub of a state machine, so a debugger stepping into a
    /// suspending call lands on the first source line of the body rather than
    /// in the stub that constructs and starts the state machine.
    /// @returns The parameterless `.ctor` MemberRef.
    func GetDebuggerStepThroughAttributeCtorRef() MemberReferenceHandle {
        if (this.debuggerStepThroughAttributeCtorRef != nil) {
            return this.debuggerStepThroughAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Diagnostics.DebuggerStepThroughAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(DebuggerStepThroughAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.debuggerStepThroughAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.debuggerStepThroughAttributeCtorRef!!
    }

    /// ADR-0122 §10 / issue #1035: returns the cached MemberRef for the
    /// parameterless constructor of
    /// `System.Runtime.CompilerServices.CompilerGeneratedAttribute`,
    /// stamped on a fixed-size buffer backing struct.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetCompilerGeneratedAttributeCtorRef() MemberReferenceHandle {
        if (this.compilerGeneratedAttributeCtorRef != nil) {
            return this.compilerGeneratedAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.CompilerGeneratedAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(CompilerGeneratedAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.compilerGeneratedAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.compilerGeneratedAttributeCtorRef!!
    }

    /// Returns the cached parameterless constructor for
    /// `System.Runtime.CompilerServices.PreserveBaseOverridesAttribute`.
    /// Covariant class overrides emitted through MethodImpl rows require this
    /// marker so further-derived overrides preserve the full base slot chain.
    /// @returns The cached constructor reference.
    func GetPreserveBaseOverridesAttributeCtorRef() MemberReferenceHandle {
        if (this.preserveBaseOverridesAttributeCtorRef != nil) {
            return this.preserveBaseOverridesAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.PreserveBaseOverridesAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(PreserveBaseOverridesAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.preserveBaseOverridesAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.preserveBaseOverridesAttributeCtorRef!!
    }

    /// ADR-0122 §10 / issue #1035: returns the cached MemberRef for the
    /// parameterless constructor of
    /// `System.Runtime.CompilerServices.UnsafeValueTypeAttribute`,
    /// stamped on a fixed-size buffer backing struct.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetUnsafeValueTypeAttributeCtorRef() MemberReferenceHandle {
        if (this.unsafeValueTypeAttributeCtorRef != nil) {
            return this.unsafeValueTypeAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.UnsafeValueTypeAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(UnsafeValueTypeAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.unsafeValueTypeAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.unsafeValueTypeAttributeCtorRef!!
    }

    /// ADR-0122 §10 / issue #1035: returns the cached MemberRef for the
    /// `FixedBufferAttribute(Type elementType, int length)` constructor,
    /// stamped on a fixed-size buffer field.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetFixedBufferAttributeCtorRef() MemberReferenceHandle {
        if (this.fixedBufferAttributeCtorRef != nil) {
            return this.fixedBufferAttributeCtorRef!!
        }
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.FixedBufferAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(FixedBufferAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let systemTypeRef = this.getTypeReference(typeof(Type))
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> {
                p.AddParameter().Type().Type(systemTypeRef, isValueType: false)
                p.AddParameter().Type().Int32()
            }
        )
        this.fixedBufferAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.fixedBufferAttributeCtorRef!!
    }

    /// Issue #834: returns the cached MemberRef for
    /// `NullableAttribute(byte)` — the compact, single-byte ctor the C#
    /// compiler picks when all positions of a NullableAttribute share the
    /// same flag value. Stamped on a Param row (or sequence-0 return Param
    /// row) when the parameter / return contributes a single nullability byte
    /// that differs from the surrounding context.
    /// @returns The cached (cref:MemberReferenceHandle), or
    /// `default` when `System.Runtime.CompilerServices.NullableAttribute`
    /// cannot be resolved from the reference closure (very old TFMs).
    func GetNullableAttributeByteCtorRef() EntityHandle {
        if (this.nullableAttributeByteCtorRef != nil) {
            return this.nullableAttributeByteCtorRef!!
        }
        if !this.TryResolveEmbeddableAttribute("System.Runtime.CompilerServices.NullableAttribute", out var attrType) {
            // The target publishes no usable declaration: bind to the copy this
            // compilation declares (embedded by EmbeddedAttributeSource, or a polyfill).
            let embeddedCtor = this.TryGetEmbeddedAttributeCtor(
                "System.Runtime.CompilerServices.NullableAttribute",
                isArrayCtor: false
            )
            if !embeddedCtor.IsNil {
                this.nullableAttributeByteCtorRef = embeddedCtor
            }
            return embeddedCtor
        }
        let attrTypeRef = this.getTypeReference(attrType!!)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> p.AddParameter().Type().Byte()
        )
        this.nullableAttributeByteCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.nullableAttributeByteCtorRef!!
    }

    /// Issue #834: returns the cached MemberRef for
    /// `NullableAttribute(byte[])` — the array-form ctor the C# compiler
    /// picks when a NullableAttribute carries inner-position bytes for nested
    /// generic-type arguments (e.g. `IEnumerable<string?>?`).
    /// @returns The cached (cref:MemberReferenceHandle), or
    /// `default` when the attribute can't be resolved.
    func GetNullableAttributeByteArrayCtorRef() EntityHandle {
        if (this.nullableAttributeByteArrayCtorRef != nil) {
            return this.nullableAttributeByteArrayCtorRef!!
        }
        if !this.TryResolveEmbeddableAttribute("System.Runtime.CompilerServices.NullableAttribute", out var attrType) {
            // The target publishes no usable declaration: bind to the copy this
            // compilation declares (embedded by EmbeddedAttributeSource, or a polyfill).
            let embeddedCtor = this.TryGetEmbeddedAttributeCtor(
                "System.Runtime.CompilerServices.NullableAttribute",
                isArrayCtor: true
            )
            if !embeddedCtor.IsNil {
                this.nullableAttributeByteArrayCtorRef = embeddedCtor
            }
            return embeddedCtor
        }
        let attrTypeRef = this.getTypeReference(attrType!!)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> p.AddParameter().Type().SZArray().Byte()
        )
        this.nullableAttributeByteArrayCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.nullableAttributeByteArrayCtorRef!!
    }

    /// ADR-0173 / issue #3627: returns the cached MemberRef for
    /// `System.Runtime.CompilerServices.ParamCollectionAttribute()` —
    /// the C#13 params-collections marker stamped on a variadic parameter
    /// whose carrier is a non-array collection (`...List[T]`,
    /// `...ReadOnlySpan[T]`, …), so C# consumers see the method as a
    /// C#13 `params X<T>` member.
    /// @returns The cached (cref:MemberReferenceHandle), or
    /// `default` when the attribute can't be resolved from
    /// the reference closure (pre-.NET 9 TFMs).
    func GetParamCollectionAttributeCtorRef() MemberReferenceHandle {
        if (this.paramCollectionAttributeCtorRef != nil) {
            return this.paramCollectionAttributeCtorRef!!
        }
        if !this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.ParamCollectionAttribute",
            requireExternalVisibility: false,
            out var attrType
        ) {
            return default(MemberReferenceHandle)
        }
        let attrTypeRef = this.getTypeReference(attrType!!)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> { }
        )
        this.paramCollectionAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.paramCollectionAttributeCtorRef!!
    }

    /// ADR-0172 Phase B: returns the cached MemberRef for
    /// `System.Runtime.CompilerServices.TupleElementNamesAttribute(string[])`
    /// — the C#-compatible carrier of tuple element names on tuple-typed
    /// parameters, returns, fields, and properties.
    /// @returns The cached (cref:MemberReferenceHandle), or
    /// `default` when the attribute can't be resolved from
    /// the reference closure (very old TFMs).
    func GetTupleElementNamesAttributeCtorRef() MemberReferenceHandle {
        if (this.tupleElementNamesAttributeCtorRef != nil) {
            return this.tupleElementNamesAttributeCtorRef!!
        }
        if !this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.TupleElementNamesAttribute",
            requireExternalVisibility: false,
            out var attrType
        ) {
            return default(MemberReferenceHandle)
        }
        let attrTypeRef = this.getTypeReference(attrType!!)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> p.AddParameter().Type().SZArray().String()
        )
        this.tupleElementNamesAttributeCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.tupleElementNamesAttributeCtorRef!!
    }

    /// Issue #834: returns the cached MemberRef for
    /// `NullableContextAttribute(byte)`. Stamped on a MethodDef row to
    /// declare the method-level default nullability flag — the per-position
    /// `NullableAttribute` rows only need to cover positions that
    /// deviate from this default.
    /// @returns The cached (cref:MemberReferenceHandle), or
    /// `default` when the attribute can't be resolved.
    func GetNullableContextAttributeByteCtorRef() EntityHandle {
        if (this.nullableContextAttributeByteCtorRef != nil) {
            return this.nullableContextAttributeByteCtorRef!!
        }
        if !this.TryResolveEmbeddableAttribute(
            "System.Runtime.CompilerServices.NullableContextAttribute",
            out var attrType
        ) {
            // The target publishes no usable declaration: bind to the copy this
            // compilation declares (embedded by EmbeddedAttributeSource, or a polyfill).
            let embeddedCtor = this.TryGetEmbeddedAttributeCtor(
                "System.Runtime.CompilerServices.NullableContextAttribute",
                isArrayCtor: false
            )
            if !embeddedCtor.IsNil {
                this.nullableContextAttributeByteCtorRef = embeddedCtor
            }
            return embeddedCtor
        }
        let attrTypeRef = this.getTypeReference(attrType!!)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> p.AddParameter().Type().Byte()
        )
        this.nullableContextAttributeByteCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        return this.nullableContextAttributeByteCtorRef!!
    }

    func GetObsoleteAttributeStringBoolCtorRef() MemberReferenceHandle {
        if (this.obsoleteAttributeStringBoolCtorRef != nil) {
            return this.obsoleteAttributeStringBoolCtorRef!!
        }
        let obsoleteType = if this
            .emitCtx
            .References
            .TryResolveType("System.ObsoleteAttribute", requireExternalVisibility: false, out var obsoleteResolved) {
            obsoleteResolved!!
        } else {
            typeof(ObsoleteAttribute)
        }
        let obsoleteTypeRef = this.getTypeReference(obsoleteType)
        let obsoleteCtorSig = BlobBuilder()
        BlobEncoder(obsoleteCtorSig).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> {
                p.AddParameter().Type().String()
                p.AddParameter().Type().Boolean()
            }
        )
        this.obsoleteAttributeStringBoolCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            obsoleteTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(obsoleteCtorSig)
        )
        return this.obsoleteAttributeStringBoolCtorRef!!
    }

    func GetSystemAttributeTypeRef() EntityHandle {
        if !(this.systemAttributeTypeRef != nil) {
            let t = if this
                .emitCtx
                .References
                .TryResolveType("System.Attribute", requireExternalVisibility: false, out var resolved) {
                resolved!!
            } else {
                typeof(Attribute)
            }
            this.systemAttributeTypeRef = this.getTypeReference(t)
        }
        return this.systemAttributeTypeRef!!
    }

    func GetSystemAttributeCtorRef() MemberReferenceHandle {
        if !(this.systemAttributeCtorRef != nil) {
            let attrTypeRef = this.GetSystemAttributeTypeRef()
            let ctorSig = BlobBuilder()
            BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
                0,
                (r ReturnTypeEncoder) -> r.Void(),
                (_ ParametersEncoder) -> { }
            )
            this.systemAttributeCtorRef = this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                attrTypeRef,
                this.emitCtx.Metadata.GetOrAddString(".ctor"),
                this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
            )
        }
        return this.systemAttributeCtorRef!!
    }

    func GetNullReferenceExceptionCtorRef() MemberReferenceHandle {
        // System.NullReferenceException::.ctor() — used to back the `!!`
        // operator's runtime check when its operand is null.
        if !this.nullRefExceptionCtorRef.IsNil {
            return this.nullRefExceptionCtorRef
        }
        let nreType = if this
            .emitCtx
            .References
            .TryResolveType("System.NullReferenceException", requireExternalVisibility: false, out var resolved) {
            resolved!!
        } else {
            typeof(NullReferenceException)
        }
        let nreTypeRef = this.getTypeReference(nreType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.nullRefExceptionCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: nreTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return this.nullRefExceptionCtorRef
    }

    /// ADR-0186 §4: `System.NullReferenceException::.ctor(string)`, which
    /// backs the coercion check inserted at a `T! -> T` boundary.
    ///
    /// The exception TYPE is deliberately the same one a user-written
    /// `!!` already throws, so existing `catch` clauses in both G#
    /// and interop code keep behaving as they do. The whole improvement is the
    /// message, which names the expression and the boundary rather than
    /// leaving an unattributed NRE (or an `ArgumentNullException` several
    /// frames inside a library) for the reader to trace. No runtime-assembly
    /// dependency is introduced: the cost is one extra `ldstr` per check.
    /// @returns A callable MemberRef for the string-taking constructor.
    func GetNullReferenceExceptionMessageCtorRef() MemberReferenceHandle {
        if !this.nullRefExceptionMessageCtorRef.IsNil {
            return this.nullRefExceptionMessageCtorRef
        }
        let nreType = if this
            .emitCtx
            .References
            .TryResolveType("System.NullReferenceException", requireExternalVisibility: false, out var resolved) {
            resolved!!
        } else {
            typeof(NullReferenceException)
        }
        let nreTypeRef = this.getTypeReference(nreType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> p.AddParameter().Type().String()
        )
        this.nullRefExceptionMessageCtorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: nreTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return this.nullRefExceptionMessageCtorRef
    }

    // Issue #504: returns a callable MemberRef for `System.Nullable<T>::get_Value`
    // closed over the supplied value-type underlying CLR type. Used by `!!` emit
    // to unwrap a `Nullable<T>` operand (throws `InvalidOperationException` at
    // runtime when `HasValue` is false, matching the BCL property).
    func GetNullableGetValueReference(underlyingValueType Type?) MemberReferenceHandle {
        if underlyingValueType == nil || !underlyingValueType.IsValueType {
            throw InvalidOperationException(
                "GetNullableGetValueReference: '${underlyingValueType?.FullName}' is not a value type."
            )
        }
        // Issue #571: route Nullable<T> construction through the
        // ReferenceResolver so the open `System.Nullable`1` definition and the
        // (possibly MLC-backed) inner value type share a load context. Building
        // it from host `typeof(System.Nullable<>)` here would yield a
        // get_Value MethodInfo whose declaring type mixes contexts, which then
        // fails as GS9998 inside the MemberRef encoding path.
        if !NullableLifting.TryConstructNullable(this.emitCtx.References, underlyingValueType, out var nullableClr) {
            throw InvalidOperationException(
                "Cannot construct Nullable<${underlyingValueType.FullName}>: System.Nullable`1 is not resolvable in the reference set."
            )
        }
        let getValue = nullableClr.GetMethod("get_Value", Type.EmptyTypes) ??
            throw InvalidOperationException(
            "System.Nullable<${underlyingValueType.FullName}>::get_Value() is not resolvable."
        )
        return this.getMethodReference(getValue)
    }

    // Issue #752 / ADR-0084 L3: returns a callable MemberRef for
    // `System.Nullable<T>::GetValueOrDefault()` closed over the supplied value-type
    // underlying CLR type. Used by `??` emit on a value-type `Nullable<T>` operand
    // on the non-null branch: since `HasValue` was just observed true, the result
    // is the same as `get_Value()` but without the BCL's redundant HasValue check
    // and exception path. No boxing, no callvirt.
    func GetNullableGetValueOrDefaultReference(underlyingValueType Type?) MemberReferenceHandle {
        if underlyingValueType == nil || !underlyingValueType.IsValueType {
            throw InvalidOperationException(
                "GetNullableGetValueOrDefaultReference: '${underlyingValueType?.FullName}' is not a value type."
            )
        }
        // Issue #571: see GetNullableGetValueReference for rationale.
        if !NullableLifting.TryConstructNullable(this.emitCtx.References, underlyingValueType, out var nullableClr) {
            throw InvalidOperationException(
                "Cannot construct Nullable<${underlyingValueType.FullName}>: System.Nullable`1 is not resolvable in the reference set."
            )
        }
        let getValueOrDefault = nullableClr.GetMethod("GetValueOrDefault", Type.EmptyTypes) ??
            throw InvalidOperationException(
            "System.Nullable<${underlyingValueType.FullName}>::GetValueOrDefault() is not resolvable."
        )
        return this.getMethodReference(getValueOrDefault)
    }

    // Issue #519: returns a callable MemberRef for `System.Nullable<T>::get_HasValue`
    // closed over the supplied value-type underlying CLR type. Used by `??` emit
    // on a value-type `Nullable<T>` operand to branch on the presence flag without
    // box/dup tricks (which are illegal on a struct stack value).
    func GetNullableGetHasValueReference(underlyingValueType Type?) MemberReferenceHandle {
        if underlyingValueType == nil || !underlyingValueType.IsValueType {
            throw InvalidOperationException(
                "GetNullableGetHasValueReference: '${underlyingValueType?.FullName}' is not a value type."
            )
        }
        // Issue #571: see GetNullableGetValueReference for rationale.
        if !NullableLifting.TryConstructNullable(this.emitCtx.References, underlyingValueType, out var nullableClr) {
            throw InvalidOperationException(
                "Cannot construct Nullable<${underlyingValueType.FullName}>: System.Nullable`1 is not resolvable in the reference set."
            )
        }
        let getHasValue = nullableClr.GetMethod("get_HasValue", Type.EmptyTypes) ??
            throw InvalidOperationException(
            "System.Nullable<${underlyingValueType.FullName}>::get_HasValue() is not resolvable."
        )
        return this.getMethodReference(getHasValue)
    }

    func GetStringLengthReference() MemberReferenceHandle {
        // System.String::get_Length() — used to implement len(string).
        let method = this
            .emitCtx
            .CoreStringType
            .GetMethod("get_Length", Type.EmptyTypes) ??
            throw InvalidOperationException("String.get_Length is not resolvable from the supplied references.")
        return this.getMethodReference(method)
    }

    func GetStringCharsReference() MemberReferenceHandle {
        // System.String::get_Chars(Int32) — used for string indexing (issue #537).
        let method = this
            .emitCtx
            .CoreStringType
            .GetMethod("get_Chars", []Type{this.emitCtx.CoreInt32Type}) ??
            throw InvalidOperationException("String.get_Chars(int) is not resolvable from the supplied references.")
        return this.getMethodReference(method)
    }

    func GetArrayLengthReference() MemberReferenceHandle {
        let method = this
            .emitCtx
            .CoreArrayType
            .GetMethod("get_Length", Type.EmptyTypes) ??
            throw InvalidOperationException("Array.get_Length is not resolvable from the supplied references.")
        return this.getMethodReference(method)
    }

    func GetTypeFromHandleReference() MemberReferenceHandle {
        // System.Type::GetTypeFromHandle(RuntimeTypeHandle) — backs `typeof(T)`.
        let method = this
            .emitCtx
            .CoreSystemType
            .GetMethod("GetTypeFromHandle", []Type{this.emitCtx.CoreRuntimeTypeHandleType}) ??
            throw InvalidOperationException(
            "Type.GetTypeFromHandle(RuntimeTypeHandle) is not resolvable from the supplied references."
        )
        return this.getMethodReference(method)
    }

    func GetMethodFromHandleReference() MemberReferenceHandle {
        // System.Reflection.MethodBase::GetMethodFromHandle(RuntimeMethodHandle)
        // — issue #2373: reconstructs a runtime MethodInfo for a CLR operator
        // method (op_Equality, op_Addition, ...) from an `ldtoken` value, used
        // when the method's declaring type is not a generic-type
        // instantiation. See GetMethodFromHandleWithDeclaringTypeReference for
        // the generic-declaring-type overload the CLR requires instead.
        let method = this
            .emitCtx
            .CoreMethodBaseType
            .GetMethod("GetMethodFromHandle", []Type{this.emitCtx.CoreRuntimeMethodHandleType}) ??
            throw InvalidOperationException(
            "MethodBase.GetMethodFromHandle(RuntimeMethodHandle) is not resolvable from the supplied references."
        )
        return this.getMethodReference(method)
    }

    func GetMethodFromHandleWithDeclaringTypeReference() MemberReferenceHandle {
        // System.Reflection.MethodBase::GetMethodFromHandle(RuntimeMethodHandle,
        // RuntimeTypeHandle) — issue #2373: required (instead of the 1-arg
        // overload) whenever the method's declaring type is itself a generic
        // instantiation (e.g. a user-defined `operator ==` on `Money<T>`
        // closed over a concrete `T`); the CLR throws at run time if the
        // 1-arg overload is used for such a method.
        let method = this
            .emitCtx
            .CoreMethodBaseType
            .GetMethod(
            "GetMethodFromHandle",
            []Type{this.emitCtx.CoreRuntimeMethodHandleType, this.emitCtx.CoreRuntimeTypeHandleType}
        ) ??
            throw InvalidOperationException(
            "MethodBase.GetMethodFromHandle(RuntimeMethodHandle, RuntimeTypeHandle) is not resolvable from the supplied references."
        )
        return this.getMethodReference(method)
    }

    func GetClosedStaticDelegateCreateReference() MemberReferenceHandle {
        // System.Delegate::CreateDelegate(Type, object, MethodInfo) creates a
        // verifiable closed-static delegate whose target supplies the method's
        // first parameter (issue #2452 extension method groups).
        let delegateType = this
            .emitCtx
            .CoreObjectType
            .Assembly
            .GetType("System.Delegate") ??
            throw InvalidOperationException("System.Delegate is not resolvable from the supplied references.")
        let methodInfoType = this
            .emitCtx
            .CoreMethodBaseType
            .Assembly
            .GetType("System.Reflection.MethodInfo") ??
            throw InvalidOperationException(
            "System.Reflection.MethodInfo is not resolvable from the supplied references."
        )
        let method = delegateType.GetMethod(
            "CreateDelegate",
            []Type{this.emitCtx.CoreSystemType, this.emitCtx.CoreObjectType, methodInfoType}
        ) ??
            throw InvalidOperationException(
            "Delegate.CreateDelegate(Type, object, MethodInfo) is not resolvable from the supplied references."
        )
        return this.getMethodReference(method)
    }

    func GetArrayCopyReference() MemberReferenceHandle {
        // System.Array::Copy(Array, Array, Int32) — used to implement append(slice, element).
        let method = this
            .emitCtx
            .CoreArrayType
            .GetMethod(
            "Copy",
            []Type{this.emitCtx.CoreArrayType, this.emitCtx.CoreArrayType, this.emitCtx.CoreInt32Type}
        ) ??
            throw InvalidOperationException(
            "Array.Copy(Array, Array, int) is not resolvable from the supplied references."
        )
        return this.getMethodReference(method)
    }

    func GetArrayCopyRangeReference() MemberReferenceHandle {
        // System.Array::Copy(Array, Int32, Array, Int32, Int32) — used to
        // materialize the captured middle slice of a list slice pattern (#1505).
        let method = this
            .emitCtx
            .CoreArrayType
            .GetMethod(
            "Copy",
            []Type{
                this.emitCtx.CoreArrayType,
                this.emitCtx.CoreInt32Type,
                this.emitCtx.CoreArrayType,
                this.emitCtx.CoreInt32Type,
                this.emitCtx.CoreInt32Type
            }
        ) ??
            throw InvalidOperationException(
            "Array.Copy(Array, int, Array, int, int) is not resolvable from the supplied references."
        )
        return this.getMethodReference(method)
    }

    func GetStringConcatReference() MemberReferenceHandle {
        if !this.stringConcatRef.IsNil {
            return this.stringConcatRef
        }
        let stringTypeRef = this.getTypeReference(this.emitCtx.CoreStringType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Type().String(),
            (ps ParametersEncoder) -> {
                ps.AddParameter().Type().String()
                ps.AddParameter().Type().String()
            }
        )
        this.stringConcatRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: stringTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("Concat"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return this.stringConcatRef
    }

    func GetStringEqualsReference() MemberReferenceHandle {
        if !this.stringEqualsRef.IsNil {
            return this.stringEqualsRef
        }
        let stringTypeRef = this.getTypeReference(this.emitCtx.CoreStringType)
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> {
                ps.AddParameter().Type().String()
                ps.AddParameter().Type().String()
            }
        )
        this.stringEqualsRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: stringTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("Equals"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return this.stringEqualsRef
    }

    func GetObjectInstanceToStringReference() MemberReferenceHandle {
        if !this.objectInstanceToStringRef.IsNil {
            return this.objectInstanceToStringRef
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().String(),
            (_ ParametersEncoder) -> { }
        )
        this.objectInstanceToStringRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("ToString"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return this.objectInstanceToStringRef
    }

    func GetObjectInstanceGetHashCodeReference() MemberReferenceHandle {
        if !this.objectInstanceGetHashCodeRef.IsNil {
            return this.objectInstanceGetHashCodeRef
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().Int32(),
            (_ ParametersEncoder) -> { }
        )
        this.objectInstanceGetHashCodeRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("GetHashCode"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return this.objectInstanceGetHashCodeRef
    }

    /// Returns a MemberRef for static `bool System.Object.Equals(object, object)`.
    /// Used by Phase 3.B.2 data-struct `==` / `!=` lowering: we box
    /// the operand values and call this static helper, which routes through
    /// the virtual `ValueType.Equals(object)` override (reflection-based
    /// field-by-field comparison) for user value types. Same observable
    /// semantics as the interpreter's structural equality (ADR-0029); a
    /// future iteration may replace this with a direct synthesized
    /// `Equals(T)` method for performance.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetObjectStaticEqualsReference() MemberReferenceHandle {
        if !this.objectStaticEqualsRef.IsNil {
            return this.objectStaticEqualsRef
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> {
                ps.AddParameter().Type().Object()
                ps.AddParameter().Type().Object()
            }
        )
        this.objectStaticEqualsRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("Equals"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return this.objectStaticEqualsRef
    }

    /// Issue #410 / ADR-0029: returns a TypeRef for `System.HashCode`,
    /// used by data-struct `GetHashCode` synthesis. Cached because the
    /// data-struct helpers need a strongly-typed handle even though the
    /// underlying (cref:MetadataTokenCache.TypeRefs) dedups by
    /// (cref:Type).
    /// @returns The cached (cref:TypeReferenceHandle).
    func GetHashCodeTypeReference() TypeReferenceHandle {
        if !this.hashCodeTypeRef.IsNil {
            return this.hashCodeTypeRef
        }
        this.hashCodeTypeRef = this.getTypeReference(typeof(HashCode))
        return this.hashCodeTypeRef
    }

    /// Issue #410 / ADR-0029: resolves an open MemberRef for the
    /// `System.HashCode.Combine<T1, ..., Tn>` overload with the
    /// given arity (1 ≤ [`arity`](paramref) ≤ 8). Each open parameter
    /// is encoded as a generic method parameter (`!!i`) and instantiated
    /// to (cref:object) via a MethodSpec at the call site.
    /// @param arity The number of generic parameters (1–8) on the desired `HashCode.Combine` overload.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetHashCodeCombineOpenReference(arity int32) MemberReferenceHandle {
        if arity < 1 || arity > 8 {
            throw ArgumentOutOfRangeException("arity", arity, "HashCode.Combine supports arities 1 through 8.")
        }
        let cached = this.hashCodeCombineOpenRefs[arity - 1]
        if (cached != nil) {
            return cached
        }
        let hashCodeRef = this.GetHashCodeTypeReference()
        // Signature: static int Combine<T1,...,Tn>(T1, ..., Tn) with `arity`
        // generic method parameters. In open form each Ti is !!i.
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: false, genericParameterCount: arity).Parameters(
            arity,
            (r ReturnTypeEncoder) -> r.Type().Int32(),
            (ps ParametersEncoder) -> {
                for var i = 0; i < arity; i++ {
                    ps.AddParameter().Type().GenericMethodTypeParameter(i)
                }
            }
        )
        let openRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            hashCodeRef,
            this.emitCtx.Metadata.GetOrAddString("Combine"),
            this.emitCtx.Metadata.GetOrAddBlob(sig)
        )
        this.hashCodeCombineOpenRefs[arity - 1] = openRef
        return openRef
    }

    /// Issue #410 / ADR-0029: resolves the open MemberRef for the instance
    /// method `System.HashCode.Add<T>(T)`, used by the >8-field
    /// fold path for `GetHashCode`.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetHashCodeAddOpenReference() MemberReferenceHandle {
        if !this.hashCodeAddOpenRef.IsNil {
            return this.hashCodeAddOpenRef
        }
        let hashCodeRef = this.GetHashCodeTypeReference()
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true, genericParameterCount: 1).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> ps.AddParameter().Type().GenericMethodTypeParameter(0)
        )
        this.hashCodeAddOpenRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            hashCodeRef,
            this.emitCtx.Metadata.GetOrAddString("Add"),
            this.emitCtx.Metadata.GetOrAddBlob(sig)
        )
        return this.hashCodeAddOpenRef
    }

    /// Issue #410 / ADR-0029: resolves the MemberRef for instance method
    /// `System.HashCode.ToHashCode()`.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetHashCodeToHashCodeReference() MemberReferenceHandle {
        if !this.hashCodeToHashCodeRef.IsNil {
            return this.hashCodeToHashCodeRef
        }
        let hashCodeRef = this.GetHashCodeTypeReference()
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().Int32(),
            (_ ParametersEncoder) -> { }
        )
        this.hashCodeToHashCodeRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            hashCodeRef,
            this.emitCtx.Metadata.GetOrAddString("ToHashCode"),
            this.emitCtx.Metadata.GetOrAddBlob(sig)
        )
        return this.hashCodeToHashCodeRef
    }

    /// ADR-0199: resolves the TypeRef for `System.Text.StringBuilder`, used by
    /// the synthesized record-format `ToString` and `PrintMembers`.
    /// @returns The cached (cref:TypeReferenceHandle).
    func GetStringBuilderTypeReference() TypeReferenceHandle {
        if this.stringBuilderTypeRef.IsNil {
            this.stringBuilderTypeRef = this.getTypeReference(typeof(StringBuilder))
        }
        return this.stringBuilderTypeRef
    }

    /// ADR-0199: resolves the MemberRef for `StringBuilder::.ctor()`.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetStringBuilderCtorReference() MemberReferenceHandle {
        if this.stringBuilderCtorRef.IsNil {
            let sig = BlobBuilder()
            BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
                0,
                (r ReturnTypeEncoder) -> r.Void(),
                (_ ParametersEncoder) -> { }
            )
            this.stringBuilderCtorRef = this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                this.GetStringBuilderTypeReference(),
                this.emitCtx.Metadata.GetOrAddString(".ctor"),
                this.emitCtx.Metadata.GetOrAddBlob(sig)
            )
        }
        return this.stringBuilderCtorRef
    }

    /// ADR-0199: resolves the MemberRef for `StringBuilder.Append(string)`.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetStringBuilderAppendStringReference() MemberReferenceHandle {
        if this.stringBuilderAppendStringRef.IsNil {
            this.stringBuilderAppendStringRef = this.AddStringBuilderAppend((p SignatureTypeEncoder) -> p.String())
        }
        return this.stringBuilderAppendStringRef
    }

    /// ADR-0199: resolves the MemberRef for `StringBuilder.Append(object)`.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetStringBuilderAppendObjectReference() MemberReferenceHandle {
        if this.stringBuilderAppendObjectRef.IsNil {
            this.stringBuilderAppendObjectRef = this.AddStringBuilderAppend((p SignatureTypeEncoder) -> p.Object())
        }
        return this.stringBuilderAppendObjectRef
    }

    /// ADR-0199: resolves the MemberRef for `StringBuilder.ToString()`.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetStringBuilderToStringReference() MemberReferenceHandle {
        if this.stringBuilderToStringRef.IsNil {
            let sig = BlobBuilder()
            BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
                0,
                (r ReturnTypeEncoder) -> r.Type().String(),
                (_ ParametersEncoder) -> { }
            )
            this.stringBuilderToStringRef = this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                this.GetStringBuilderTypeReference(),
                this.emitCtx.Metadata.GetOrAddString("ToString"),
                this.emitCtx.Metadata.GetOrAddBlob(sig)
            )
        }
        return this.stringBuilderToStringRef
    }

    /// ADR-0068 / issue #698: resolves a MemberReferenceHandle for the
    /// parameter-less instance method `System.Object::Finalize()`. Used
    /// by every emitted `deinit` destructor to chain to the base
    /// finalizer via the wrapping `finally`, exactly as the C# compiler
    /// emits for `~Type()`.
    /// @returns The cached (cref:MemberReferenceHandle).
    func GetObjectFinalizeRef() MemberReferenceHandle {
        if (this.objectFinalizeRef != nil) {
            return this.objectFinalizeRef!!
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this.objectFinalizeRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString("Finalize"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
        return this.objectFinalizeRef!!
    }

    /// Issue #3811: resolves a <em>compiler-embeddable</em> attribute — one the
    /// C# compiler <b>synthesizes into the emitting assembly</b> when the target
    /// framework does not publish it (`NullableAttribute`,
    /// `NullableContextAttribute`) — and accepts the answer only when it is
    /// <b>externally visible</b>.
    ///
    /// The plain lookup with `requireExternalVisibility: false` is wrong
    /// for this family. Because csc embeds a private copy into every assembly
    /// whose target framework lacks the type, practically every
    /// `netstandard2.0` package assembly carries an `internal`
    /// `NullableAttribute` of its own, and the first declarer in the
    /// reference closure is simply whichever of those the resolver reached
    /// first — for `src/Sdk/Gsharp.NET.Sdk` that was
    /// `Microsoft.Build.Framework`, whose copy exists only in its
    /// `ref/netstandard2.0` asset. Scoping the TypeRef there emits a
    /// cross-assembly reference to a type that is neither public nor present in
    /// that package's other assets, so a downstream compilation resolving the
    /// same package for a different TFM throws
    /// `TypeLoadException: Could not find type
    /// 'System.Runtime.CompilerServices.NullableAttribute' in assembly ''`
    /// while reading the referencing assembly's nullability metadata — surfaced
    /// as the internal-compiler-error diagnostic `GS9998`.
    ///
    /// External visibility is exactly the right discriminator: an embedded copy
    /// is <em>always</em> `internal`, while every targeting pack from
    /// .NET 5 onwards declares
    /// `System.Runtime.CompilerServices.NullableAttribute` as a
    /// <b>public</b> type of `System.Runtime`. The resolver's
    /// externally-visible overload additionally skips an inaccessible shim and
    /// keeps searching for an accessible duplicate (issue #3445), so a closure
    /// containing both an embedded copy and the real contract assembly resolves
    /// to the contract assembly. When nothing public declares it — a downlevel
    /// target such as netstandard2.0 — the accessors bind to an embedded copy
    /// declared in this assembly (issue #4922, (cref:EmbeddedAttributeSource)); a
    /// target on a runtime that cannot embed (no source copy) keeps the old
    /// outcome of omitting the attribute. A declaration found only through the host
    /// fallback (issue #4921) counts as "nothing public declares it" for a
    /// downlevel target (cref:ReferenceResolver.TryResolvePublishedEmbeddableAttribute).
    /// @param fullName The attribute's fully-qualified metadata name.
    /// @param attributeType The resolved, externally visible attribute type.
    /// @returns `true` when an externally visible declaration was found; otherwise `false`.
    private func TryResolveEmbeddableAttribute(fullName string, @NotNullWhen(true) out attributeType Type?) bool -> this
        .emitCtx
        .References
        .TryResolvePublishedEmbeddableAttribute(fullName, out attributeType)

    /// Issue #4922: returns the constructor of a copy of the embeddable
    /// attribute <em>declared in the compilation's own source</em> (the copy
    /// (cref:EmbeddedAttributeSource) injected for a target that publishes none, or a
    /// polyfill the user wrote), the way csc binds to its embedded copy.
    /// The result is a bare MethodDef: it lives in this assembly, so it needs no
    /// assembly reference.
    /// @param fullName The attribute's fully-qualified metadata name.
    /// @param isArrayCtor `true` to select the `(byte[])` ctor, `false` for `(byte)`.
    /// @returns The MethodDef handle, or `default` when the source declares no usable copy.
    private func TryGetEmbeddedAttributeCtor(fullName string, isArrayCtor bool) EntityHandle {
        if this.tokenCache == nil {
            return default(EntityHandle)
        }
        return EmbeddedAttributeSource.FindSourceConstructor(
            this.emitCtx.Program.Structs,
            this.tokenCache,
            fullName,
            isArrayCtor
        )
    }

    private func BuildObjectDefaultCtorReference() MemberReferenceHandle {
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: this.ObjectTypeRef,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    private func AddStringBuilderAppend(encodeParameter(SignatureTypeEncoder) -> void) MemberReferenceHandle {
        let builderRef = this.GetStringBuilderTypeReference()
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Type().Type(builderRef, isValueType: false),
            (ps ParametersEncoder) -> encodeParameter(ps.AddParameter().Type())
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            builderRef,
            this.emitCtx.Metadata.GetOrAddString("Append"),
            this.emitCtx.Metadata.GetOrAddBlob(sig)
        )
    }
}
