// <copyright file="RectangularArrayTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent

/// Represents a CLR rectangular array type such as `[,]T` or `[,,]T`.
class RectangularArrayTypeSymbol : TypeSymbol {
    private init(elementType TypeSymbol, rank int32) : base(
        "[${String(',', rank - 1)}]${elementType.Name}",
        elementType.ClrType?.MakeArrayType(rank)
    ) {
        ElementType = elementType
        Rank = rank
    }

    /// Gets array element type.
    prop ElementType TypeSymbol {
        get;
    }

    /// Gets array rank.
    prop Rank int32 {
        get;
    }

    shared {
        private let Cache ConcurrentDictionary[
            (Element TypeSymbol, Rank int32),
            RectangularArrayTypeSymbol
        ] = ConcurrentDictionary[(Element TypeSymbol, Rank int32), RectangularArrayTypeSymbol]()

        /// Gets cached rectangular array symbol.
        /// @param elementType Element type.
        /// @param rank Array rank.
        /// @returns Cached symbol.
        func Get(elementType TypeSymbol, rank int32) RectangularArrayTypeSymbol {
            ArgumentNullException.ThrowIfNull(elementType, paramName: "elementType")
            if rank < 2 || rank > 32 {
                throw ArgumentOutOfRangeException("rank", "Rectangular arrays require rank 2 through 32.")
            }
            return Cache.GetOrAdd(
                (elementType, rank),
                (key(Element TypeSymbol, Rank int32)) -> RectangularArrayTypeSymbol(key.Element, key.Rank)
            )
        }

        internal func ClearCache() -> Cache.Clear()
    }
}
