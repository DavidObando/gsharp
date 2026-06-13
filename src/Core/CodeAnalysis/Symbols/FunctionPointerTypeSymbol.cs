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

    private FunctionPointerTypeSymbol(string name, CallingConvention callingConvention, ImmutableArray<TypeSymbol> parameterTypes, TypeSymbol returnType)
        : base(name, typeof(System.IntPtr))
    {
        CallingConvention = callingConvention;
        ParameterTypes = parameterTypes;
        ReturnType = returnType;
    }

    /// <summary>Gets the unmanaged calling convention used to invoke through this pointer.</summary>
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
            _ => new FunctionPointerTypeSymbol(displayName, callingConvention, parameterTypes, returnType ?? TypeSymbol.Void));
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
