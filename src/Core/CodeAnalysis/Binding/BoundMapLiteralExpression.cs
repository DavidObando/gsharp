// <copyright file="BoundMapLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound map literal expression — <c>map[K,V]{k1: v1, k2: v2, …}</c>
/// (Phase 3.A.4).
/// </summary>
public sealed class BoundMapLiteralExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundMapLiteralExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="mapType">The map type symbol.</param>
    /// <param name="entries">The bound key/value entries.</param>
    public BoundMapLiteralExpression(SyntaxNode syntax, MapTypeSymbol mapType, ImmutableArray<BoundMapEntry> entries)
        : base(syntax)
    {
        MapType = mapType ?? throw new ArgumentNullException(nameof(mapType));
        Entries = entries;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.MapLiteralExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => MapType;

    /// <summary>Gets the map type symbol.</summary>
    public MapTypeSymbol MapType { get; }

    /// <summary>Gets the bound key/value entries.</summary>
    public ImmutableArray<BoundMapEntry> Entries { get; }
}

/// <summary>
/// A single bound <c>key: value</c> entry in a <see cref="BoundMapLiteralExpression"/>.
/// </summary>
public sealed class BoundMapEntry
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundMapEntry"/> class.
    /// </summary>
    /// <param name="key">The bound key expression.</param>
    /// <param name="value">The bound value expression.</param>
    public BoundMapEntry(BoundExpression key, BoundExpression value)
    {
        Key = key ?? throw new ArgumentNullException(nameof(key));
        Value = value ?? throw new ArgumentNullException(nameof(value));
    }

    /// <summary>Gets the bound key expression.</summary>
    public BoundExpression Key { get; }

    /// <summary>Gets the bound value expression.</summary>
    public BoundExpression Value { get; }
}
