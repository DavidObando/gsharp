#nullable disable

// <copyright file="SliceTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a variable-length slice type <c>[]T</c>.
/// </summary>
/// <remarks>
/// Phase 3.A.2 / ADR-0016 — backing representation is the CLR
/// single-dimensional zero-based array <c>T[]</c>. <c>len(s)</c> and
/// <c>cap(s)</c> both return <c>s.Length</c>; <c>append(s, v)</c>
/// allocates a new array of length <c>+1</c>, copies, and writes the
/// new element. Full Go slice header semantics (independent
/// length/capacity, aliased backing array) are intentionally deferred.
/// Instances are cached per element type so identical slice types
/// compare by reference.
/// </remarks>
public sealed class SliceTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<TypeSymbol, SliceTypeSymbol> Cache = new();

    private SliceTypeSymbol(TypeSymbol elementType)
        : base($"[]{elementType.Name}", NullableLifting.GetEffectiveClrType(elementType)?.MakeArrayType())
    {
        ElementType = elementType;
    }

    /// <summary>
    /// Gets the element type.
    /// </summary>
    public TypeSymbol ElementType { get; }

    /// <summary>
    /// Gets or creates the slice type symbol for the given element type.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <returns>The cached <see cref="SliceTypeSymbol"/>.</returns>
    public static SliceTypeSymbol Get(TypeSymbol elementType)
    {
        if (elementType == null)
        {
            throw new ArgumentNullException(nameof(elementType));
        }

        return Cache.GetOrAdd(elementType, e => new SliceTypeSymbol(e));
    }
}
