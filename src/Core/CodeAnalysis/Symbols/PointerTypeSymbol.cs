#nullable disable

// <copyright file="PointerTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an <em>unmanaged</em> raw pointer type <c>*T</c> (CLR
/// <c>ELEMENT_TYPE_PTR</c>, the faithful mapping of C# <c>T*</c>). Distinct from
/// <see cref="ByRefTypeSymbol"/>, which models a <em>managed</em> by-ref pointer
/// (<c>ELEMENT_TYPE_BYREF</c>, <c>T&amp;</c>). Unmanaged pointers are only legal
/// inside an <c>unsafe</c> context (ADR-0122 / issue #1014); unlike managed
/// by-refs they may be stored in fields, declared as locals, and passed as plain
/// (non-ref-kind) P/Invoke parameters.
/// </summary>
/// <remarks>
/// Instances are interned per pointee type for identity equality, mirroring
/// <see cref="ByRefTypeSymbol"/>.
/// </remarks>
public sealed class PointerTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<TypeSymbol, PointerTypeSymbol> Cache = new();

    private PointerTypeSymbol(TypeSymbol pointeeType)
        : base($"*{pointeeType.Name}", pointeeType.ClrType?.MakePointerType())
    {
        PointeeType = pointeeType;
    }

    /// <summary>
    /// Gets the pointee (element) type that this unmanaged pointer refers to.
    /// </summary>
    public TypeSymbol PointeeType { get; }

    /// <summary>
    /// Gets or creates the interned <see cref="PointerTypeSymbol"/> for the given pointee type.
    /// </summary>
    /// <param name="pointeeType">The type being pointed to.</param>
    /// <returns>The cached <see cref="PointerTypeSymbol"/>.</returns>
    public static PointerTypeSymbol Get(TypeSymbol pointeeType)
    {
        if (pointeeType == null)
        {
            throw new ArgumentNullException(nameof(pointeeType));
        }

        return Cache.GetOrAdd(pointeeType, pt => new PointerTypeSymbol(pt));
    }
}
