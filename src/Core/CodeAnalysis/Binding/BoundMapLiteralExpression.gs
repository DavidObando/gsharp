// <copyright file="BoundMapLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// Bound map literal expression — `map[K,V]{k1: v1, k2: v2, …}`
/// (Phase 3.A.4).
class BoundMapLiteralExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundMapLiteralExpression) class.
    /// @param syntax The originating syntax.
    /// @param mapType The map type symbol.
    /// @param entries The bound key/value entries.
    init(syntax SyntaxNode?, mapType MapTypeSymbol, entries ImmutableArray[BoundMapEntry]) : base(syntax) {
        MapType = mapType ?? throw ArgumentNullException("mapType")
        Entries = entries
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.MapLiteralExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> MapType

    /// Gets the map type symbol.
    prop MapType MapTypeSymbol {
        get;
    }

    /// Gets the bound key/value entries.
    prop Entries ImmutableArray[BoundMapEntry] {
        get;
    }
}

/// A single bound `key: value` entry in a (cref:BoundMapLiteralExpression).
data class BoundMapEntry : IEquatable[BoundMapEntry] {
    /// Initializes a new instance of the (cref:BoundMapEntry) class.
    /// @param key The bound key expression.
    /// @param value The bound value expression.
    init(key BoundExpression, value BoundExpression) {
        Key = key ?? throw ArgumentNullException("key")
        Value = value ?? throw ArgumentNullException("value")
    }

    /// Gets the bound key expression.
    prop Key BoundExpression {
        get;
    }

    /// Gets the bound value expression.
    prop Value BoundExpression {
        get;
    }
}
