// <copyright file="RectangularArrayTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;

namespace GSharp.Core.CodeAnalysis.Symbols;

#pragma warning disable SA1611
#pragma warning disable SA1615

/// <summary>
/// Represents a CLR rectangular array type such as <c>[,]T</c> or <c>[,,]T</c>.
/// </summary>
public sealed class RectangularArrayTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<(TypeSymbol Element, int Rank), RectangularArrayTypeSymbol> Cache = new();

    private RectangularArrayTypeSymbol(TypeSymbol elementType, int rank)
        : base(
            $"[{new string(',', rank - 1)}]{elementType.Name}",
            elementType.ClrType?.MakeArrayType(rank))
    {
        ElementType = elementType;
        Rank = rank;
    }

    #pragma warning restore SA1615
    #pragma warning restore SA1611

    /// <summary>Gets array element type.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>Gets array rank.</summary>
    public int Rank { get; }

    /// <summary>Gets cached rectangular array symbol.</summary>
    /// <param name="elementType">Element type.</param>
    /// <param name="rank">Array rank.</param>
    /// <returns>Cached symbol.</returns>
    public static RectangularArrayTypeSymbol Get(TypeSymbol elementType, int rank)
    {
        ArgumentNullException.ThrowIfNull(elementType);
        if (rank is < 2 or > 32)
        {
            throw new ArgumentOutOfRangeException(nameof(rank), "Rectangular arrays require rank 2 through 32.");
        }

        return Cache.GetOrAdd((elementType, rank), key => new RectangularArrayTypeSymbol(key.Element, key.Rank));
    }

    internal static void ClearCache() => Cache.Clear();
}
