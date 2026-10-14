// <copyright file="PinningShapes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Issue #3755 (issue #3705, family 3 — the load-context family; the remedy is
/// #3754's): the two well-known members the `fixed` / pointer lowering
/// emits calls to, resolved from the <em>compilation's reference closure</em>
/// rather than from the SDK hosting `gsc`.
///
/// Both sites used to read their member off a live host `typeof` —
/// `typeof(System.Runtime.CompilerServices.Unsafe).GetMethods(...)` and
/// `typeof(string).GetMethod("GetPinnableReference", ...)` — so they
/// answered for the framework `gsc` is <em>running on</em>, never for the
/// framework it is <em>compiling against</em>. #3755 ranked them as hygiene on
/// the grounds that "none of the types involved is plausibly absent from a
/// target framework". Measured against the targeting packs that ship in the
/// .NET SDK, that ranking does not hold for either of them:
///
/// - `System.Runtime.CompilerServices.Unsafe` is absent from `NETStandard.Library.Ref/2.1.0` altogether
/// — it is a NuGet package there, not part of the framework. #3729's
/// `ImportedMemberRefFactory.GetTypeReference` projection therefore had nothing to project onto and
/// fell back to the host type, so <em>every</em> `fixed` statement compiled against a `netstandard2.x`
/// closure emitted a `TypeRef` scoped to the host's `System.Private.CoreLib` and the compile reported
/// success. That is #3730's defect exactly, on a different member.
/// - `System.String` is present in every target, but `String.GetPinnableReference()` is <em>not</em>:
/// it arrived in netstandard2.1's successors and is absent from `NETStandard.Library.Ref/2.1.0`. A
/// member-level absence is invisible to the "is the type absent?" reasoning #3755 ranked by, and no
/// type projection can repair it — the emitted `MemberRef` named a method the target does not declare,
/// and the failure surfaced as a `MissingMethodException` at the target's runtime.
///
/// Resolution goes through (cref:ReferenceResolver.TryResolveType(string, out Type))
/// and member probes compare with (cref:ClrTypeUtilities.IsSameAs)
/// rather than host `typeof` identity, because the resolved members are
/// `MetadataLoadContext` types on every real `/reference:` compile.
/// A target that provides neither is reported as `GS0546` instead of
/// emitting a reference its runtime cannot resolve.
internal shared class PinningShapes {
    /// The metadata name of the type carrying `AsPointer<T>`.
    const UnsafeTypeFullName string = "System.Runtime.CompilerServices.Unsafe"

    /// The display signature used when a target does not provide `AsPointer<T>`.
    const UnsafeAsPointerSignature string = UnsafeTypeFullName + ".AsPointer<T>(ref T)"

    /// The display signature used when a target does not provide `GetPinnableReference`.
    const StringGetPinnableReferenceSignature string = "System.String.GetPinnableReference()"

    /// Resolves the target framework's open `Unsafe.AsPointer<T>(ref T)`
    /// definition.
    /// @param references The compilation's reference closure.
    /// @param asPointer The open generic method definition.
    /// @returns `true` when the target declares it.
    func TryGetUnsafeAsPointer(references ReferenceResolver, @NotNullWhen(true) out asPointer MethodInfo?) bool {
        asPointer = nil
        if !references.TryResolveType(UnsafeTypeFullName, out var unsafeType) {
            return false
        }
        for candidate in unsafeType!!.GetMethods(BindingFlags.Public | BindingFlags.Static) {
            if candidate.Name == "AsPointer" && candidate.IsGenericMethodDefinition && candidate.GetGenericArguments()
                .Length == 1 &&
                candidate
                .GetParameters().Length == 1 {
                asPointer = candidate
                return true
            }
        }
        return false
    }

    /// Resolves the target framework's `String.GetPinnableReference()`.
    /// @remarks The declaring type is (cref:EmitContext.CoreStringType), which is
    /// already resolved from the reference closure; only the member probe was
    /// still reading off the host, and the member is the half that actually
    /// varies between targets.
    /// @param coreStringType The target framework's `System.String`.
    /// @param getPinnableReference The resolved method.
    /// @returns `true` when the target declares it.
    func TryGetStringGetPinnableReference(
        coreStringType Type,
        @NotNullWhen(true) out getPinnableReference MethodInfo?
    ) bool {
        getPinnableReference = nil
        for candidate in coreStringType.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
            // `ref readonly char` reads back as a by-ref type whose element is
            // `char`; comparing the element with IsSameAs keeps the probe
            // answerable across reflection contexts, where reference identity
            // against a host `typeof(char)` never matches.
            if candidate.Name == "GetPinnableReference" &&
                !candidate.IsGenericMethodDefinition &&
                candidate
                .GetParameters()
                .Length == 0 &&
                candidate
                .ReturnType
                .IsByRef &&
                candidate
                .ReturnType
                .GetElementType()
                .IsSameAs(typeof(char)) {
                getPinnableReference = candidate
                return true
            }
        }
        return false
    }

    /// Closes an open generic definition over [`typeArgument`](paramref),
    /// projecting the argument into [`open`](paramref)'s reflection
    /// context first.
    /// @remarks Left unprojected, closing a method resolved from the reference closure
    /// over a host `RuntimeType` (every built-in (cref:TypeSymbol)
    /// wraps one) yields a `MethodBuilderInstantiation` whose
    /// `GetParameters()` answers the <em>unsubstituted</em> type
    /// parameter — the cross-context artefact #3752 hit through
    /// `MakeGenericType` and #3754 through `MakeGenericMethod`. The
    /// projection is best-effort by construction: a type the reference set
    /// cannot name falls back to the raw argument rather than failing the emit.
    /// @param open The open generic method definition.
    /// @param typeArgument The type argument to close over.
    /// @returns The closed method.
    func CloseOver($open MethodInfo, typeArgument Type) MethodInfo -> $open.MakeGenericMethod(
        ClrTypeUtilities.RemapHostCoreTypeToContext(typeArgument, $open.DeclaringType) ?? typeArgument
    )
}
