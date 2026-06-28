#nullable disable

// <copyright file="ArrayTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a fixed-length array type <c>[N]T</c>.
/// </summary>
/// <remarks>
/// Phase 3.A.1 only supports fixed-length arrays; variable-length slice
/// types (<c>[]T</c>) land in Phase 3.A.2 and will be a sibling symbol.
/// Instances are cached by (element, length) so that array types declared
/// with the same shape compare equal by reference.
/// </remarks>
public sealed class ArrayTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<(TypeSymbol Element, int Length), ArrayTypeSymbol> Cache = new();

    private ArrayTypeSymbol(TypeSymbol elementType, int length)
        : base($"[{length}]{elementType.Name}", NullableLifting.GetEffectiveClrType(elementType)?.MakeArrayType())
    {
        ElementType = elementType;
        Length = length;
    }

    /// <summary>
    /// Gets the element type.
    /// </summary>
    public TypeSymbol ElementType { get; }

    /// <summary>
    /// Gets the fixed length of the array.
    /// </summary>
    public int Length { get; }

    /// <summary>
    /// Gets or creates the array type symbol for the given element type and length.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <param name="length">The fixed array length.</param>
    /// <returns>The cached <see cref="ArrayTypeSymbol"/>.</returns>
    public static ArrayTypeSymbol Get(TypeSymbol elementType, int length)
    {
        if (elementType == null)
        {
            throw new ArgumentNullException(nameof(elementType));
        }

        return Cache.GetOrAdd((elementType, length), key => new ArrayTypeSymbol(key.Element, key.Length));
    }
}
