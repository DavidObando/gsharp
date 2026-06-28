#nullable disable

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
        : base(name, typeof(System.IntPtr))
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
        var displayName = BuildDisplayName(callingConvention, parameterTypes, returnType ?? TypeSymbol.Void);
        return Cache.GetOrAdd(
            displayName,
            _ => new FunctionPointerTypeSymbol(displayName, isManaged: false, callingConvention, parameterTypes, returnType ?? TypeSymbol.Void));
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
        var displayName = BuildManagedDisplayName(parameterTypes, returnType ?? TypeSymbol.Void);
        return Cache.GetOrAdd(
            displayName,
            _ => new FunctionPointerTypeSymbol(displayName, isManaged: true, CallingConvention.Winapi, parameterTypes, returnType ?? TypeSymbol.Void));
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
