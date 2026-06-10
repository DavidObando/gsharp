// <copyright file="TupleTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Linq;
using System.Text;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a tuple type <c>(T1, T2, ...)</c> (Phase 4.5).
/// </summary>
/// <remarks>
/// Backed by the CLR <c>System.ValueTuple&lt;...&gt;</c> family. Instances are
/// cached per element-type sequence so identical tuple types compare by
/// reference. The CLR backing type is only set for tuple arities 1–8 (the
/// generic ValueTuple shapes shipped in the BCL); higher arities currently
/// have a <c>null</c> ClrType and are interpreter-only.
/// </remarks>
public sealed class TupleTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<string, TupleTypeSymbol> Cache = new();

    private TupleTypeSymbol(ImmutableArray<TypeSymbol> elementTypes)
        : base(BuildName(elementTypes), BuildClrType(elementTypes))
    {
        ElementTypes = elementTypes;
    }

    /// <summary>Gets the tuple element types in declaration order.</summary>
    public ImmutableArray<TypeSymbol> ElementTypes { get; }

    /// <summary>Gets the arity of the tuple.</summary>
    public int Arity => ElementTypes.Length;

    /// <summary>Returns the cached <see cref="TupleTypeSymbol"/> for the given element types.</summary>
    /// <param name="elementTypes">The element types in order.</param>
    /// <returns>The (cached) tuple type symbol.</returns>
    public static TupleTypeSymbol Get(ImmutableArray<TypeSymbol> elementTypes)
    {
        if (elementTypes.IsDefaultOrEmpty || elementTypes.Length < 2)
        {
            throw new ArgumentException("Tuples must have at least two element types.", nameof(elementTypes));
        }

        var key = BuildName(elementTypes);

        // Issue #649: The cache is keyed by name alone (e.g. "(Holder, string)").
        // Across compilations in the same process (common in tests), different
        // TypeSymbol instances with the same name may appear (loaded from
        // different MetadataLoadContext instances). Validate that the cached
        // entry's element types still match by reference; if not, replace it.
        if (Cache.TryGetValue(key, out var existing))
        {
            if (existing.ElementTypes.SequenceEqual(elementTypes))
            {
                return existing;
            }
        }

        var result = new TupleTypeSymbol(elementTypes);
        Cache[key] = result;
        return result;
    }

    private static string BuildName(ImmutableArray<TypeSymbol> elementTypes)
    {
        var sb = new StringBuilder("(");
        for (var i = 0; i < elementTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(elementTypes[i].Name);
        }

        sb.Append(')');
        return sb.ToString();
    }

    private static Type BuildClrType(ImmutableArray<TypeSymbol> elementTypes)
    {
        if (elementTypes.Any(t => t.ClrType == null))
        {
            return null;
        }

        var clrTypes = elementTypes.Select(t => t.ClrType).ToArray();
        switch (clrTypes.Length)
        {
            case 2: return typeof(ValueTuple<,>).MakeGenericType(clrTypes);
            case 3: return typeof(ValueTuple<,,>).MakeGenericType(clrTypes);
            case 4: return typeof(ValueTuple<,,,>).MakeGenericType(clrTypes);
            case 5: return typeof(ValueTuple<,,,,>).MakeGenericType(clrTypes);
            case 6: return typeof(ValueTuple<,,,,,>).MakeGenericType(clrTypes);
            case 7: return typeof(ValueTuple<,,,,,,>).MakeGenericType(clrTypes);
            default: return null;
        }
    }
}
