// <copyright file="FunctionPointerTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Runtime.InteropServices;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a raw, unmanaged function-pointer type clause
/// (ADR-0095 / issue #761) — the G# spelling
/// <c>unmanaged[CC] (T1, T2, ...) -&gt; R</c>. Encoded as CLR
/// <c>ELEMENT_TYPE_FNPTR</c> in metadata; the runtime representation is an
/// address-sized integer (interconvertible with <see cref="System.IntPtr"/>
/// / <c>nint</c>).
/// </summary>
/// <remarks>
/// Instances are interned by structural identity (calling convention,
/// parameter types, return type) so two textually identical type clauses
/// share the same symbol — matching <see cref="FunctionTypeSymbol"/>'s
/// caching policy.
/// </remarks>
public sealed class FunctionPointerTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<string, FunctionPointerTypeSymbol> Cache = new ConcurrentDictionary<string, FunctionPointerTypeSymbol>();

    private FunctionPointerTypeSymbol(string name, bool isManaged, CallingConvention callingConvention, ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
        : this(name, isManaged, callingConvention, parameterTypes, returnType, isUnmanagedExtended: false, ImmutableArray<string>.Empty, ImmutableArray<Type>.Empty)
    {
    }

    private FunctionPointerTypeSymbol(
        string name,
        bool isManaged,
        CallingConvention callingConvention,
        ImmutableArray<TypeSymbol> parameterTypes,
        TypeSymbol returnType,
        bool isUnmanagedExtended,
        ImmutableArray<string> unmanagedConventions,
        ImmutableArray<Type> unmanagedConventionClrTypes)
        : base(name, typeof(nint))
    {
        IsManaged = isManaged;
        CallingConvention = callingConvention;
        ParameterTypes = parameterTypes;
        ReturnType = returnType;
        IsUnmanagedExtended = isUnmanagedExtended;
        UnmanagedConventions = unmanagedConventions;
        UnmanagedConventionClrTypes = unmanagedConventionClrTypes;
    }

    /// <summary>
    /// Gets a value indicating whether this is a <em>managed</em> function
    /// pointer (ADR-0122 §9 / issue #1035, spelled <c>*func(T1, T2) R</c>) that
    /// is callable directly via the CIL <c>calli</c> opcode with the default
    /// managed calling convention. When <see langword="false"/> this is the
    /// <em>unmanaged</em> raw function pointer (ADR-0095, spelled
    /// <c>unmanaged[CC] (T1, T2) -&gt; R</c>) whose ABI is given by
    /// <see cref="CallingConvention"/>.
    /// </summary>
    public bool IsManaged { get; }

    /// <summary>Gets the unmanaged calling convention used to invoke through this pointer. Ignored when <see cref="IsManaged"/> is <see langword="true"/> and meaningless when <see cref="IsUnmanagedExtended"/> is <see langword="true"/>.</summary>
    public CallingConvention CallingConvention { get; }

    /// <summary>
    /// Gets a value indicating whether this unmanaged pointer uses the open
    /// CLR calling-convention model (ADR-0095 v2 / issue #3611): the
    /// signature encodes <c>SignatureCallingConvention.Unmanaged</c> and the
    /// conventions (if any) ride as <c>CallConv*</c> modopts on the return
    /// type. <see langword="true"/> for bare <c>unmanaged (T) -&gt; R</c>
    /// (platform default, empty <see cref="UnmanagedConventions"/>) and for
    /// every non-legacy or combined <c>[CC, ...]</c> list.
    /// </summary>
    public bool IsUnmanagedExtended { get; }

    /// <summary>
    /// Gets the open-model convention short names in source order (e.g.
    /// <c>Cdecl</c>, <c>SuppressGCTransition</c> — without the
    /// <c>CallConv</c> prefix). Empty for the bare platform-default form
    /// and for legacy/managed pointers.
    /// </summary>
    public ImmutableArray<string> UnmanagedConventions { get; }

    /// <summary>
    /// Gets the resolved <c>System.Runtime.CompilerServices.CallConv{Name}</c>
    /// types matching <see cref="UnmanagedConventions"/> pairwise; the
    /// emitter writes these as return-type modopts. Same staleness contract
    /// as <see cref="TypeSymbol.ClrType"/> (cleared with the cache when the
    /// owning metadata load context is disposed).
    /// </summary>
    public ImmutableArray<Type> UnmanagedConventionClrTypes { get; }

    /// <summary>Gets the function pointer's parameter types.</summary>
    public ImmutableArray<TypeSymbol> ParameterTypes { get; }

    /// <summary>Gets the function pointer's return type. <see cref="TypeSymbol.Void"/> for a void-returning pointer.</summary>
    public TypeSymbol ReturnType { get; }

    /// <summary>Gets the number of parameters of the pointed-to function.</summary>
    public int Arity => ParameterTypes.Length;

    /// <summary>
    /// Returns the cached <see cref="FunctionPointerTypeSymbol"/> for the
    /// given calling convention and signature.
    /// </summary>
    /// <param name="callingConvention">The unmanaged calling convention.</param>
    /// <param name="parameterTypes">The parameter types.</param>
    /// <param name="returnType">The return type (use <see cref="TypeSymbol.Void"/> for no return).</param>
    /// <returns>A cached <see cref="FunctionPointerTypeSymbol"/>.</returns>
    public static FunctionPointerTypeSymbol Get(CallingConvention callingConvention, ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
        returnType ??= TypeSymbol.Void;
        var displayName = BuildDisplayName(callingConvention, parameterTypes, returnType);
        var key = BuildIdentityKey("u", callingConvention.ToString(), parameterTypes, returnType);
        return Cache.GetOrAdd(
            key,
            _ => new FunctionPointerTypeSymbol(displayName, isManaged: false, callingConvention, parameterTypes, returnType));
    }

    /// <summary>
    /// Returns the cached open-model unmanaged
    /// <see cref="FunctionPointerTypeSymbol"/> (ADR-0095 v2 / issue #3611):
    /// bare <c>unmanaged (T) -&gt; R</c> when <paramref name="conventions"/>
    /// is empty (the platform-default ABI), otherwise
    /// <c>unmanaged[CC, ...] (T) -&gt; R</c> whose conventions encode as
    /// <c>CallConv*</c> return-type modopts in source order.
    /// </summary>
    /// <param name="conventions">The convention short names in source order (may be empty).</param>
    /// <param name="conventionClrTypes">The resolved <c>CallConv{Name}</c> types, pairwise with <paramref name="conventions"/>.</param>
    /// <param name="parameterTypes">The parameter types.</param>
    /// <param name="returnType">The return type (use <see cref="TypeSymbol.Void"/> for no return).</param>
    /// <returns>A cached open-model <see cref="FunctionPointerTypeSymbol"/>.</returns>
    public static FunctionPointerTypeSymbol GetUnmanagedExtended(
        ImmutableArray<string> conventions,
        ImmutableArray<Type> conventionClrTypes,
        ImmutableArray<TypeSymbol> parameterTypes,
        TypeSymbol returnType)
    {
        returnType ??= TypeSymbol.Void;
        conventions = conventions.IsDefault ? ImmutableArray<string>.Empty : conventions;
        conventionClrTypes = conventionClrTypes.IsDefault ? ImmutableArray<Type>.Empty : conventionClrTypes;
        var displayName = BuildExtendedDisplayName(conventions, parameterTypes, returnType);

        // Source order is identity (ADR-0095 v2 §Binding): the modopt blob
        // is order-sensitive, so the key joins the names unsorted.
        var key = BuildIdentityKey("ux", string.Join(",", conventions), parameterTypes, returnType);
        return Cache.GetOrAdd(
            key,
            _ => new FunctionPointerTypeSymbol(
                displayName,
                isManaged: false,
                CallingConvention.Winapi,
                parameterTypes,
                returnType,
                isUnmanagedExtended: true,
                conventions,
                conventionClrTypes));
    }

    /// <summary>
    /// Returns the cached <em>managed</em> <see cref="FunctionPointerTypeSymbol"/>
    /// for the given signature (ADR-0122 §9 / issue #1035, spelled
    /// <c>*func(T1, T2) R</c>). Managed function pointers use the default
    /// managed calling convention and are callable directly via <c>calli</c>.
    /// </summary>
    /// <param name="parameterTypes">The parameter types.</param>
    /// <param name="returnType">The return type (use <see cref="TypeSymbol.Void"/> for no return).</param>
    /// <returns>A cached managed <see cref="FunctionPointerTypeSymbol"/>.</returns>
    public static FunctionPointerTypeSymbol GetManaged(ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
        returnType ??= TypeSymbol.Void;
        var displayName = BuildManagedDisplayName(parameterTypes, returnType);
        var key = BuildIdentityKey("m", null, parameterTypes, returnType);
        return Cache.GetOrAdd(
            key,
            _ => new FunctionPointerTypeSymbol(displayName, isManaged: true, CallingConvention.Winapi, parameterTypes, returnType));
    }

    /// <summary>
    /// Recursively substitutes this pointer's parameter and return types while
    /// preserving its managed/unmanaged ABI.
    /// </summary>
    /// <param name="substitute">Substitution applied to each signature type.</param>
    /// <returns>This symbol when unchanged; otherwise the interned substituted symbol.</returns>
    internal FunctionPointerTypeSymbol Substitute(System.Func<TypeSymbol, TypeSymbol> substitute)
    {
        var parameters = ImmutableArray.CreateBuilder<TypeSymbol>(ParameterTypes.Length);
        var changed = false;
        foreach (var parameterType in ParameterTypes)
        {
            var substituted = substitute(parameterType);
            parameters.Add(substituted);
            changed |= !ReferenceEquals(substituted, parameterType);
        }

        var returnType = substitute(ReturnType);
        changed |= !ReferenceEquals(returnType, ReturnType);
        if (!changed)
        {
            return this;
        }

        if (IsManaged)
        {
            return GetManaged(parameters.MoveToImmutable(), returnType);
        }

        return IsUnmanagedExtended
            ? GetUnmanagedExtended(UnmanagedConventions, UnmanagedConventionClrTypes, parameters.MoveToImmutable(), returnType)
            : Get(CallingConvention, parameters.MoveToImmutable(), returnType);
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    /// <summary>
    /// Issue #1624: builds an identity-correct cache key using
    /// <see cref="FunctionTypeSymbol.AppendIdentityKey"/> — the same builder
    /// <see cref="FunctionTypeSymbol"/> and <see cref="TupleTypeSymbol"/> use —
    /// so two distinct types that merely share a display name (e.g. a
    /// same-named parameter type loaded from different compilations) never
    /// alias in this process-wide cache.
    /// </summary>
    private static string BuildIdentityKey(string kindTag, string? callingConventionTag, ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append('!').Append(kindTag);
        if (callingConventionTag != null)
        {
            sb.Append('[').Append(callingConventionTag).Append(']');
        }

        sb.Append('(');
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(',');
            }

            FunctionTypeSymbol.AppendIdentityKey(sb, parameterTypes[i]);
        }

        sb.Append(")->");
        FunctionTypeSymbol.AppendIdentityKey(sb, returnType);
        return sb.ToString();
    }

    private static string BuildManagedDisplayName(ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
        // ADR-0122 §9 / issue #1035: managed function pointer `*func(T1, T2) R`,
        // consistent with the `*T` pointer prefix and the `func name(params) Ret`
        // declaration form.
        var sb = new System.Text.StringBuilder();
        sb.Append("*func(");
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(parameterTypes[i]?.Name ?? "?");
        }

        sb.Append(')');
        if (returnType != TypeSymbol.Void)
        {
            sb.Append(' ').Append(returnType?.Name ?? "?");
        }

        return sb.ToString();
    }

    private static string BuildExtendedDisplayName(ImmutableArray<string> conventions, ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
        // ADR-0095 v2: the canonical display form mirrors the source
        // spelling — bare `unmanaged (T) -> R` for the platform default,
        // `unmanaged[Cdecl, SuppressGCTransition] (T) -> R` for a list.
        var sb = new System.Text.StringBuilder();
        sb.Append("unmanaged");
        if (!conventions.IsEmpty)
        {
            sb.Append('[').Append(string.Join(", ", conventions)).Append(']');
        }

        sb.Append(" (");
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(parameterTypes[i]?.Name ?? "?");
        }

        sb.Append(") -> ");
        sb.Append(returnType == TypeSymbol.Void ? "void" : returnType?.Name ?? "?");
        return sb.ToString();
    }

    private static string BuildDisplayName(CallingConvention callingConvention, ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
    {
        // ADR-0095 §2: the canonical display form mirrors the source
        // spelling — `unmanaged[Cdecl] (T1, T2, ...) -> R`.
        var sb = new System.Text.StringBuilder();
        sb.Append("unmanaged[").Append(callingConvention).Append("] (");
        for (var i = 0; i < parameterTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(parameterTypes[i]?.Name ?? "?");
        }

        sb.Append(") -> ");
        sb.Append(returnType == TypeSymbol.Void ? "void" : returnType?.Name ?? "?");
        return sb.ToString();
    }
}
