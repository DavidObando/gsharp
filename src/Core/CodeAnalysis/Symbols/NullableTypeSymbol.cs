// <copyright file="NullableTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Phase 3.C.1 / ADR-0001: wraps an underlying <see cref="TypeSymbol"/> to
/// indicate that values of this type may be the absence-of-value (nil).
/// </summary>
/// <remarks>
/// In Phase 3.C.1 the wrapper is purely a binder-level annotation: emit and
/// the evaluator treat <see cref="UnderlyingType"/> as the runtime type. The
/// nil literal, null-safe operators, and smart casts follow in Phase 3.C.2–4.
/// </remarks>
public sealed class NullableTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<TypeSymbol, NullableTypeSymbol> Cache = new();

    private NullableTypeSymbol(TypeSymbol underlyingType)
        : base(underlyingType.Name + "?", underlyingType.ClrType)
    {
        UnderlyingType = underlyingType;
    }

    /// <summary>Gets the non-nullable underlying type.</summary>
    public TypeSymbol UnderlyingType { get; }

    /// <summary>Returns the cached <see cref="NullableTypeSymbol"/> wrapping the given underlying type.</summary>
    /// <param name="underlyingType">The non-nullable underlying type.</param>
    /// <returns>A cached nullable wrapper. Wrapping a <see cref="NullableTypeSymbol"/> is a no-op.</returns>
    public static NullableTypeSymbol Get(TypeSymbol underlyingType)
    {
        if (underlyingType is NullableTypeSymbol already)
        {
            return already;
        }

        return Cache.GetOrAdd(underlyingType, t => new NullableTypeSymbol(t));
    }

    /// <summary>
    /// Issue #530: returns the effective CLR <see cref="Type"/> to use when
    /// matching <paramref name="typeSymbol"/> as a method argument in overload
    /// resolution. For a <see cref="NullableTypeSymbol"/> wrapping a value
    /// type, this returns <c>Nullable&lt;T&gt;</c> rather than the underlying
    /// <c>T</c>, because the emitter encodes the local as <c>Nullable&lt;T&gt;</c>
    /// and the selected overload must accept that type on the evaluation stack.
    /// For all other types the result equals <c>typeSymbol?.ClrType</c>.
    /// </summary>
    /// <param name="typeSymbol">The type symbol to resolve.</param>
    /// <returns>The CLR <see cref="Type"/> to use for overload resolution, or <see langword="null"/> if <paramref name="typeSymbol"/> is <see langword="null"/>.</returns>
    public static Type GetEffectiveClrType(TypeSymbol typeSymbol)
    {
        if (typeSymbol is NullableTypeSymbol nullable
            && nullable.UnderlyingType?.ClrType is { IsValueType: true } innerVt)
        {
            return typeof(Nullable<>).MakeGenericType(innerVt);
        }

        return typeSymbol?.ClrType;
    }
}
