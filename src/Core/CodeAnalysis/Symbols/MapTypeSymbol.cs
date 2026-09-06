// <copyright file="MapTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;

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
    /// <summary>The full name of the CLR type a <c>map[K, V]</c> IS (ADR-0104).</summary>
    private const string DictionaryFullName = "System.Collections.Generic.Dictionary`2";

    private static readonly ConcurrentDictionary<(TypeSymbol, TypeSymbol), MapTypeSymbol> Cache = new();

    private MapTypeSymbol(TypeSymbol keyType, TypeSymbol valueType)

        // TypeSymbol's legacy CLR-type constructor accepts null for symbolic
        // same-compilation key/value types.
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

    /// <summary>
    /// Issue #3987: recognizes a map-shaped type by SHAPE rather than by
    /// spelling — G#'s own <see cref="MapTypeSymbol"/>, or the
    /// <c>System.Collections.Generic.Dictionary&lt;K, V&gt;</c> it IS
    /// (ADR-0104 identity) arriving from metadata as an
    /// <see cref="ImportedTypeSymbol"/>.
    /// </summary>
    /// <remarks>
    /// The direct analogue of <see cref="ChannelTypeSymbol.TryGetChannelShape"/>
    /// and <see cref="SequenceTypeSymbol.TryGetEnumerableInterfaceShape"/>, and
    /// it exists for the same reason: with CLOSED key/value types the two
    /// spellings are already identity because <c>Conversion</c> compares their
    /// <see cref="TypeSymbol.ClrType"/>s, but the moment one of them is open
    /// both <c>ClrType</c>s are null and the comparison has nothing left to
    /// read. Which name the author (or the metadata) happened to use is not a
    /// fact about the type.
    /// </remarks>
    /// <param name="type">The candidate type.</param>
    /// <param name="keyType">The recovered key type.</param>
    /// <param name="valueType">The recovered value type.</param>
    /// <returns>True when <paramref name="type"/> is map-shaped.</returns>
    public static bool TryGetMapShape(
        TypeSymbol? type,
        [NotNullWhen(true)] out TypeSymbol? keyType,
        [NotNullWhen(true)] out TypeSymbol? valueType)
    {
        keyType = null;
        valueType = null;

        switch (type)
        {
            case null:
                return false;
            case NullabilityAnnotatedTypeSymbol annotated:
                return TryGetMapShape(annotated.BaseType, out keyType, out valueType);
            case MapTypeSymbol map:
                keyType = map.KeyType;
                valueType = map.ValueType;
                return true;
            case ImportedTypeSymbol imported:
            {
                var open = imported.OpenDefinition;
                if (open == null && imported.ClrType is { IsGenericType: true } closed)
                {
                    open = closed.GetGenericTypeDefinition();
                }

                if (open?.FullName != DictionaryFullName)
                {
                    return false;
                }

                if (imported.TypeArguments.Length == 2)
                {
                    keyType = imported.TypeArguments[0];
                    valueType = imported.TypeArguments[1];
                    return true;
                }

                if (imported.ClrType is { IsGenericType: true } closedShape)
                {
                    var arguments = closedShape.GetGenericArguments();
                    if (arguments.Length != 2)
                    {
                        return false;
                    }

                    keyType = FromClrType(arguments[0]);
                    valueType = FromClrType(arguments[1]);
                    return keyType != null && valueType != null;
                }

                return false;
            }

            default:
                return false;
        }
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    private static Type? MakeClrType(TypeSymbol keyType, TypeSymbol valueType)
    {
        if (keyType.ClrType == null || valueType.ClrType == null)
        {
            return null;
        }

        return typeof(Dictionary<,>).MakeGenericType(keyType.ClrType, valueType.ClrType);
    }
}
