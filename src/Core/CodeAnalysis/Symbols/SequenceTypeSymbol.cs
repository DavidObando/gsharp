// <copyright file="SequenceTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a sequence type <c>sequence[T]</c> — alias for <c>IEnumerable&lt;T&gt;</c> (ADR-0040).
/// </summary>
public sealed class SequenceTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<TypeSymbol, SequenceTypeSymbol> Cache = new();

    private SequenceTypeSymbol(TypeSymbol elementType)
        : base($"sequence[{elementType.Name}]", MakeClrType(elementType))
    {
        ElementType = elementType;
    }

    /// <summary>Gets the element type.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>
    /// Gets or creates the sequence type symbol for the given element type.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <returns>The cached <see cref="SequenceTypeSymbol"/>.</returns>
    public static SequenceTypeSymbol Get(TypeSymbol elementType)
    {
        if (elementType == null)
        {
            throw new ArgumentNullException(nameof(elementType));
        }

        return Cache.GetOrAdd(elementType, et => new SequenceTypeSymbol(et));
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    private static Type MakeClrType(TypeSymbol elementType)
    {
        if (elementType.ClrType == null)
        {
            return null;
        }

        return typeof(IEnumerable<>).MakeGenericType(elementType.ClrType);
    }
}
