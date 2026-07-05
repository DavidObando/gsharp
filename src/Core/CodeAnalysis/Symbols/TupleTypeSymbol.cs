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
        // Issue #2119: an element that is a constructed generic over an in-scope
        // type parameter (e.g. `IEnumerator[T]`) has a NON-null but type-erased
        // ClrType (`IEnumerator<object>`). Building a closed CLR tuple from that
        // erases `T` to `object`, so the value-tuple local/field emitted for a
        // deconstruction expects `IEnumerator<object>` while the stack carries
        // `IEnumerator<T>` (ilverify StackUnexpected). Force a null ClrType so
        // the emitter routes through the symbolic TypeSpec path (GetTupleTypeSpec
        // -> EncodeTypeSymbol), which preserves each element's real `G<T>` shape.
        // The bare `ClrType == null` check below only covered a bare `T` element.
        if (elementTypes.Any(t => t.ClrType == null || TypeSymbol.ContainsTypeParameter(t)))
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
