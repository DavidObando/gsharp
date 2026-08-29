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

    private TupleTypeSymbol(ImmutableArray<TypeSymbol> elementTypes, ImmutableArray<string?> elementNames)

        // TypeSymbol's legacy CLR-type constructor accepts null for symbolic
        // same-compilation element types. Element names never affect the CLR
        // backing (ADR-0172: names are metadata over the positional shape).
        : base(BuildName(elementTypes, elementNames), BuildClrType(elementTypes))
    {
        ElementTypes = elementTypes;
        ElementNames = elementNames;
    }

    /// <summary>Gets the tuple element types in declaration order.</summary>
    public ImmutableArray<TypeSymbol> ElementTypes { get; }

    /// <summary>
    /// Gets the declared element names, parallel to
    /// <see cref="ElementTypes"/> with <see langword="null"/> at unnamed
    /// positions — or an empty array for a fully unnamed tuple (ADR-0172).
    /// Names are metadata: they never affect the CLR backing, conversions,
    /// or equality; same-shape tuples differing only in names are related by
    /// an identity conversion.
    /// </summary>
    public ImmutableArray<string?> ElementNames { get; }

    /// <summary>Gets a value indicating whether any element declares a name.</summary>
    public bool HasNames => !ElementNames.IsDefaultOrEmpty;

    /// <summary>Gets the arity of the tuple.</summary>
    public int Arity => ElementTypes.Length;

    /// <summary>Returns the cached <see cref="TupleTypeSymbol"/> for the given element types.</summary>
    /// <param name="elementTypes">The element types in order.</param>
    /// <returns>The (cached) tuple type symbol.</returns>
    public static TupleTypeSymbol Get(ImmutableArray<TypeSymbol> elementTypes)
        => Get(elementTypes, elementNames: default);

    /// <summary>
    /// Returns the cached <see cref="TupleTypeSymbol"/> for the given element
    /// types and names (ADR-0172). A default/empty or all-<see langword="null"/>
    /// name array yields the canonical unnamed tuple.
    /// </summary>
    /// <param name="elementTypes">The element types in order.</param>
    /// <param name="elementNames">The element names, parallel to <paramref name="elementTypes"/>, <see langword="null"/> where unnamed.</param>
    /// <returns>The (cached) tuple type symbol.</returns>
    public static TupleTypeSymbol Get(ImmutableArray<TypeSymbol> elementTypes, ImmutableArray<string?> elementNames)
    {
        if (elementTypes.IsDefaultOrEmpty || elementTypes.Length < 2)
        {
            throw new ArgumentException("Tuples must have at least two element types.", nameof(elementTypes));
        }

        if (!elementNames.IsDefaultOrEmpty && elementNames.Length != elementTypes.Length)
        {
            throw new ArgumentException("Element names must parallel element types.", nameof(elementNames));
        }

        if (!elementNames.IsDefaultOrEmpty && elementNames.All(n => n == null))
        {
            elementNames = ImmutableArray<string?>.Empty;
        }

        if (elementNames.IsDefault)
        {
            elementNames = ImmutableArray<string?>.Empty;
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

        // ADR-0172: names participate in the cache key (a named and an
        // unnamed same-shape tuple are distinct interned symbols related by
        // an identity conversion), with an empty suffix for the canonical
        // unnamed tuple so pre-existing keys are unchanged.
        if (elementNames.Length > 0)
        {
            keyBuilder.Append('|');
            for (var i = 0; i < elementNames.Length; i++)
            {
                if (i > 0)
                {
                    keyBuilder.Append(',');
                }

                keyBuilder.Append(elementNames[i]);
            }
        }

        var key = keyBuilder.ToString();
        return Cache.GetOrAdd(key, _ => new TupleTypeSymbol(elementTypes, elementNames));
    }

    /// <summary>
    /// Returns the canonical fully unnamed tuple of this tuple's shape,
    /// recursively stripping names from nested tuple elements (ADR-0172).
    /// Two tuples denote the same type exactly when their
    /// <see cref="WithoutNames"/> results are reference-equal.
    /// </summary>
    /// <returns>The (cached) unnamed same-shape tuple symbol.</returns>
    public TupleTypeSymbol WithoutNames()
    {
        var stripped = ImmutableArray.CreateBuilder<TypeSymbol>(ElementTypes.Length);
        var changed = HasNames;
        foreach (var elementType in ElementTypes)
        {
            var strippedElement = StripNames(elementType);
            stripped.Add(strippedElement);
            changed |= !ReferenceEquals(strippedElement, elementType);
        }

        return changed ? Get(stripped.MoveToImmutable()) : this;
    }

    /// <summary>
    /// Finds the zero-based position of a declared element name (ordinal,
    /// case-sensitive), or returns <see langword="false"/>.
    /// </summary>
    /// <param name="name">The element name to find.</param>
    /// <param name="index">The zero-based element index when found.</param>
    /// <returns>Whether the name is declared on this tuple.</returns>
    public bool TryGetElementIndexByName(string name, out int index)
    {
        if (HasNames)
        {
            for (var i = 0; i < ElementNames.Length; i++)
            {
                if (string.Equals(ElementNames[i], name, StringComparison.Ordinal))
                {
                    index = i;
                    return true;
                }
            }
        }

        index = -1;
        return false;
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

    internal static Type? BuildClrType(Type[] elementTypes)
        => BuildClrType(elementTypes, 0, elementTypes.Length);

    private static TypeSymbol StripNames(TypeSymbol type) => type switch
    {
        TupleTypeSymbol tuple => tuple.WithoutNames(),
        NullableTypeSymbol { UnderlyingType: TupleTypeSymbol nested } => NullableTypeSymbol.Get(nested.WithoutNames()),
        _ => type,
    };

    private static string BuildName(ImmutableArray<TypeSymbol> elementTypes, ImmutableArray<string?> elementNames)
    {
        var sb = new StringBuilder("(");
        for (var i = 0; i < elementTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            if (!elementNames.IsDefaultOrEmpty && elementNames[i] != null)
            {
                sb.Append(elementNames[i]);
                sb.Append(' ');
            }

            sb.Append(elementTypes[i].Name);
        }

        sb.Append(')');
        return sb.ToString();
    }

    private static Type? BuildClrType(ImmutableArray<TypeSymbol> elementTypes)
    {
        // Issues #2119/#2702: a symbolic constructed generic has a non-null but
        // object-erased ClrType. Keep the tuple symbolic so signature encoding
        // preserves the real nested generic arguments.
        if (elementTypes.Any(t => t.ClrType == null || TypeSymbol.RequiresSymbolicProjection(t)))
        {
            return null;
        }

        var clrTypes = elementTypes
            .Select(t => Invariant.Required(
                NullableTypeSymbol.GetEffectiveClrType(t),
                "a CLR-backed tuple element has a CLR type"))
            .ToArray();
        return BuildClrType(clrTypes);
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
