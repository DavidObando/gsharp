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
        : base(name, typeof(nint))
    {
        IsManaged = isManaged;
        CallingConvention = callingConvention;
        ParameterTypes = parameterTypes;
        ReturnType = returnType;
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

    /// <summary>Gets the unmanaged calling convention used to invoke through this pointer. Ignored when <see cref="IsManaged"/> is <see langword="true"/>.</summary>
    public CallingConvention CallingConvention { get; }

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
    private static string BuildIdentityKey(string kindTag, string callingConventionTag, ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
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
