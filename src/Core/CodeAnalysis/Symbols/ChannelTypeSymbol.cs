// <copyright file="ChannelTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Threading.Channels;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a Go-style channel type <c>chan T</c>.
/// </summary>
/// <remarks>
/// Phase 5.4 / ADR-0022 — backing representation is the BCL
/// <c>System.Threading.Channels.Channel&lt;T&gt;</c>. Instances are
/// cached per element type so identical channel types compare by
/// reference.
/// </remarks>
public sealed class ChannelTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<TypeSymbol, ChannelTypeSymbol> Cache = new();

    private ChannelTypeSymbol(TypeSymbol elementType)
        : base($"chan {elementType.Name}", MakeClrType(elementType))
    {
        ElementType = elementType;
    }

    /// <summary>Gets the channel element type.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>
    /// Gets or creates the channel type symbol for the given element type.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <returns>The cached <see cref="ChannelTypeSymbol"/>.</returns>
    public static ChannelTypeSymbol Get(TypeSymbol elementType)
    {
        if (elementType == null)
        {
            throw new ArgumentNullException(nameof(elementType));
        }

        return Cache.GetOrAdd(elementType, e => new ChannelTypeSymbol(e));
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

        return typeof(Channel<>).MakeGenericType(elementType.ClrType);
    }
}
