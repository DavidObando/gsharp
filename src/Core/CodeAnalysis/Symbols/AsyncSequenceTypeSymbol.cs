#nullable disable

// <copyright file="AsyncSequenceTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an async sequence type — the contextual alias for
/// <c>System.Collections.Generic.IAsyncEnumerable&lt;T&gt;</c> produced when
/// <c>sequence[T]</c> appears in the return-type position of an
/// <c>async func</c> (ADR-0041). Outside the return-type position of an
/// <c>async func</c>, <c>sequence[T]</c> still resolves to the synchronous
/// <see cref="SequenceTypeSymbol"/> (ADR-0040).
/// </summary>
public sealed class AsyncSequenceTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<TypeSymbol, AsyncSequenceTypeSymbol> Cache = new();

    private AsyncSequenceTypeSymbol(TypeSymbol elementType)
        : base($"sequence[{elementType.Name}]", MakeClrType(elementType))
    {
        ElementType = elementType;
    }

    /// <summary>Gets the element type.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>
    /// Gets or creates the async-sequence type symbol for the given element type.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <returns>The cached <see cref="AsyncSequenceTypeSymbol"/>.</returns>
    public static AsyncSequenceTypeSymbol Get(TypeSymbol elementType)
    {
        if (elementType == null)
        {
            throw new ArgumentNullException(nameof(elementType));
        }

        return Cache.GetOrAdd(elementType, et => new AsyncSequenceTypeSymbol(et));
    }

    private static Type MakeClrType(TypeSymbol elementType)
    {
        if (elementType.ClrType == null)
        {
            return null;
        }

        return typeof(IAsyncEnumerable<>).MakeGenericType(elementType.ClrType);
    }
}
