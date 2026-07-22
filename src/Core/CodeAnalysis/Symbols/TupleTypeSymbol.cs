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
/// reference. Arity 8 and higher use the CLR's canonical
/// <c>ValueTuple&lt;T1,...,T7,TRest&gt;</c> nesting.
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

        // Issue #1624: key on element-type *identity* (via FunctionTypeSymbol's
        // shared identity-key builder), not the display name. A name-based key
        // (e.g. "(Holder, string)") can alias two distinct same-named types
        // from different compilations; the previous fix (#649) validated
        // identity on lookup but then racily overwrote the cache entry on a
        // mismatch, so concurrent callers could still observe two distinct
        // instances for the same elements. GetOrAdd is atomic, so no overwrite
        // is needed once the key itself is identity-correct.
        var keyBuilder = new StringBuilder();
        for (var i = 0; i < elementTypes.Length; i++)
        {
            if (i > 0)
            {
                keyBuilder.Append(',');
            }

            FunctionTypeSymbol.AppendIdentityKey(keyBuilder, elementTypes[i]);
        }

        var key = keyBuilder.ToString();
        return Cache.GetOrAdd(key, _ => new TupleTypeSymbol(elementTypes));
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    internal static Type GetOpenClrType(int arity)
        => arity switch
        {
            1 => typeof(ValueTuple<>),
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            8 => typeof(ValueTuple<,,,,,,,>),
            _ => throw new ArgumentOutOfRangeException(nameof(arity)),
        };

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
        // Issues #2119/#2702: a symbolic constructed generic has a non-null but
        // object-erased ClrType. Keep the tuple symbolic so signature encoding
        // preserves the real nested generic arguments.
        if (elementTypes.Any(t => t.ClrType == null || TypeSymbol.RequiresSymbolicProjection(t)))
        {
            return null;
        }

        var clrTypes = elementTypes.Select(t => t.ClrType).ToArray();
        return BuildClrType(clrTypes, 0, clrTypes.Length);
    }

    private static Type BuildClrType(Type[] elementTypes, int start, int count)
    {
        if (count <= 7)
        {
            return GetOpenClrType(count).MakeGenericType(elementTypes[start..(start + count)]);
        }

        var arguments = new Type[8];
        Array.Copy(elementTypes, start, arguments, 0, 7);
        arguments[7] = BuildClrType(elementTypes, start + 7, count - 7);
        return GetOpenClrType(8).MakeGenericType(arguments);
    }
}
