#nullable disable

// <copyright file="MapTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a G# map type <c>map[K,V]</c>.
/// </summary>
/// <remarks>
/// ADR-0104 (supersedes Phase 3.A.4 Go-flavored <c>map[K]V</c>) — backing
/// representation is the CLR
/// <c>System.Collections.Generic.Dictionary&lt;K, V&gt;</c>. The literal
/// form <c>map[K,V]{k: v, …}</c> populates a freshly allocated dictionary;
/// <c>m[k]</c> indexes it; the <c>delete(m, k)</c> built-in removes a
/// key; <c>len(m)</c> returns <c>Count</c>. Instances are cached per
/// <c>(K, V)</c> pair so identical map types compare by reference.
/// </remarks>
public sealed class MapTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<(TypeSymbol, TypeSymbol), MapTypeSymbol> Cache = new();

    private MapTypeSymbol(TypeSymbol keyType, TypeSymbol valueType)
        : base($"map[{keyType.Name},{valueType.Name}]", MakeClrType(keyType, valueType))
    {
        KeyType = keyType;
        ValueType = valueType;
    }

    /// <summary>Gets the key type.</summary>
    public TypeSymbol KeyType { get; }

    /// <summary>Gets the value type.</summary>
    public TypeSymbol ValueType { get; }

    /// <summary>
    /// Gets or creates the map type symbol for the given key and value types.
    /// </summary>
    /// <param name="keyType">The key type.</param>
    /// <param name="valueType">The value type.</param>
    /// <returns>The cached <see cref="MapTypeSymbol"/>.</returns>
    public static MapTypeSymbol Get(TypeSymbol keyType, TypeSymbol valueType)
    {
        if (keyType == null)
        {
            throw new ArgumentNullException(nameof(keyType));
        }

        if (valueType == null)
        {
            throw new ArgumentNullException(nameof(valueType));
        }

        return Cache.GetOrAdd((keyType, valueType), k => new MapTypeSymbol(k.Item1, k.Item2));
    }

    private static Type MakeClrType(TypeSymbol keyType, TypeSymbol valueType)
    {
        if (keyType.ClrType == null || valueType.ClrType == null)
        {
            return null;
        }

        return typeof(Dictionary<,>).MakeGenericType(keyType.ClrType, valueType.ClrType);
    }
}
