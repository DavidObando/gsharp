// <copyright file="PinningShapes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Issue #3755 (issue #3705, family 3 — the load-context family; the remedy is
/// #3754's): the two well-known members the <c>fixed</c> / pointer lowering
/// emits calls to, resolved from the <em>compilation's reference closure</em>
/// rather than from the SDK hosting <c>gsc</c>.
/// <para>
/// Both sites used to read their member off a live host <c>typeof</c> —
/// <c>typeof(System.Runtime.CompilerServices.Unsafe).GetMethods(...)</c> and
/// <c>typeof(string).GetMethod("GetPinnableReference", ...)</c> — so they
/// answered for the framework <c>gsc</c> is <em>running on</em>, never for the
/// framework it is <em>compiling against</em>. #3755 ranked them as hygiene on
/// the grounds that "none of the types involved is plausibly absent from a
/// target framework". Measured against the targeting packs that ship in the
/// .NET SDK, that ranking does not hold for either of them:
/// </para>
/// <list type="bullet">
/// <item><description><c>System.Runtime.CompilerServices.Unsafe</c> is absent
/// from <c>NETStandard.Library.Ref/2.1.0</c> altogether — it is a NuGet package
/// there, not part of the framework. #3729's
/// <c>ImportedMemberRefFactory.GetTypeReference</c> projection therefore had
/// nothing to project onto and fell back to the host type, so <em>every</em>
/// <c>fixed</c> statement compiled against a <c>netstandard2.x</c> closure
/// emitted a <c>TypeRef</c> scoped to the host's <c>System.Private.CoreLib</c>
/// and the compile reported success. That is #3730's defect exactly, on a
/// different member.</description></item>
/// <item><description><c>System.String</c> is present in every target, but
/// <c>String.GetPinnableReference()</c> is <em>not</em>: it arrived in
/// netstandard2.1's successors and is absent from
/// <c>NETStandard.Library.Ref/2.1.0</c>. A member-level absence is invisible to
/// the "is the type absent?" reasoning #3755 ranked by, and no type projection
/// can repair it — the emitted <c>MemberRef</c> named a method the target does
/// not declare, and the failure surfaced as a
/// <c>MissingMethodException</c> at the target's runtime.</description></item>
/// </list>
/// <para>
/// Resolution goes through <see cref="ReferenceResolver.TryResolveType(string, out Type)"/>
/// and member probes compare with <see cref="ClrTypeUtilities.IsSameAs"/>
/// rather than host <c>typeof</c> identity, because the resolved members are
/// <c>MetadataLoadContext</c> types on every real <c>/reference:</c> compile.
/// A target that provides neither is reported as <c>GS0546</c> instead of
/// emitting a reference its runtime cannot resolve.
/// </para>
/// </summary>
internal static class PinningShapes
{
    /// <summary>The metadata name of the type carrying <c>AsPointer&lt;T&gt;</c>.</summary>
    public const string UnsafeTypeFullName = "System.Runtime.CompilerServices.Unsafe";

    /// <summary>The display signature used when a target does not provide <c>AsPointer&lt;T&gt;</c>.</summary>
    public const string UnsafeAsPointerSignature = UnsafeTypeFullName + ".AsPointer<T>(ref T)";

    /// <summary>The display signature used when a target does not provide <c>GetPinnableReference</c>.</summary>
    public const string StringGetPinnableReferenceSignature = "System.String.GetPinnableReference()";

    /// <summary>
    /// Resolves the target framework's open <c>Unsafe.AsPointer&lt;T&gt;(ref T)</c>
    /// definition.
    /// </summary>
    /// <param name="references">The compilation's reference closure.</param>
    /// <param name="asPointer">The open generic method definition.</param>
    /// <returns><see langword="true"/> when the target declares it.</returns>
    public static bool TryGetUnsafeAsPointer(
        ReferenceResolver references,
        [NotNullWhen(true)] out MethodInfo? asPointer)
    {
        asPointer = null;
        if (!references.TryResolveType(UnsafeTypeFullName, out var unsafeType))
        {
            return false;
        }

        foreach (var candidate in unsafeType.GetMethods(BindingFlags.Public | BindingFlags.Static))
        {
            if (candidate.Name == "AsPointer"
                && candidate.IsGenericMethodDefinition
                && candidate.GetGenericArguments().Length == 1
                && candidate.GetParameters().Length == 1)
            {
                asPointer = candidate;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Resolves the target framework's <c>String.GetPinnableReference()</c>.
    /// </summary>
    /// <remarks>
    /// The declaring type is <see cref="EmitContext.CoreStringType"/>, which is
    /// already resolved from the reference closure; only the member probe was
    /// still reading off the host, and the member is the half that actually
    /// varies between targets.
    /// </remarks>
    /// <param name="coreStringType">The target framework's <c>System.String</c>.</param>
    /// <param name="getPinnableReference">The resolved method.</param>
    /// <returns><see langword="true"/> when the target declares it.</returns>
    public static bool TryGetStringGetPinnableReference(
        Type coreStringType,
        [NotNullWhen(true)] out MethodInfo? getPinnableReference)
    {
        getPinnableReference = null;
        foreach (var candidate in coreStringType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            // `ref readonly char` reads back as a by-ref type whose element is
            // `char`; comparing the element with IsSameAs keeps the probe
            // answerable across reflection contexts, where reference identity
            // against a host `typeof(char)` never matches.
            if (candidate.Name == "GetPinnableReference"
                && !candidate.IsGenericMethodDefinition
                && candidate.GetParameters().Length == 0
                && candidate.ReturnType.IsByRef
                && candidate.ReturnType.GetElementType().IsSameAs(typeof(char)))
            {
                getPinnableReference = candidate;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Closes an open generic definition over <paramref name="typeArgument"/>,
    /// projecting the argument into <paramref name="open"/>'s reflection
    /// context first.
    /// </summary>
    /// <remarks>
    /// Left unprojected, closing a method resolved from the reference closure
    /// over a host <c>RuntimeType</c> (every built-in <see cref="TypeSymbol"/>
    /// wraps one) yields a <c>MethodBuilderInstantiation</c> whose
    /// <c>GetParameters()</c> answers the <em>unsubstituted</em> type
    /// parameter — the cross-context artefact #3752 hit through
    /// <c>MakeGenericType</c> and #3754 through <c>MakeGenericMethod</c>. The
    /// projection is best-effort by construction: a type the reference set
    /// cannot name falls back to the raw argument rather than failing the emit.
    /// </remarks>
    /// <param name="open">The open generic method definition.</param>
    /// <param name="typeArgument">The type argument to close over.</param>
    /// <returns>The closed method.</returns>
    public static MethodInfo CloseOver(MethodInfo open, Type typeArgument)
        => open.MakeGenericMethod(
            ClrTypeUtilities.RemapHostCoreTypeToContext(typeArgument, open.DeclaringType) ?? typeArgument);
}
