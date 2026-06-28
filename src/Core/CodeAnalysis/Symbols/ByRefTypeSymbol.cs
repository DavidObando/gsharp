#nullable disable

// <copyright file="ByRefTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a managed by-ref pointer type <c>*T</c> (CLR <c>ELEMENT_TYPE_BYREF</c>).
/// Instances are interned per pointee type for identity equality.
/// </summary>
public sealed class ByRefTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<TypeSymbol, ByRefTypeSymbol> Cache = new();

    private ByRefTypeSymbol(TypeSymbol pointeeType)
        : base($"*{pointeeType.Name}", pointeeType.ClrType?.MakeByRefType())
    {
        PointeeType = pointeeType;
    }

    /// <summary>
    /// Gets the pointee (element) type that this by-ref pointer refers to.
    /// </summary>
    public TypeSymbol PointeeType { get; }

    /// <summary>
    /// Gets or creates the interned <see cref="ByRefTypeSymbol"/> for the given pointee type.
    /// </summary>
    /// <param name="pointeeType">The type being pointed to.</param>
    /// <returns>The cached <see cref="ByRefTypeSymbol"/>.</returns>
    public static ByRefTypeSymbol Get(TypeSymbol pointeeType)
    {
        if (pointeeType == null)
        {
            throw new ArgumentNullException(nameof(pointeeType));
        }

        return Cache.GetOrAdd(pointeeType, pt => new ByRefTypeSymbol(pt));
    }
}
