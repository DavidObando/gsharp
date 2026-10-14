// <copyright file="ArrayTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent

/// Represents a fixed-length array type `[N]T`.
/// @remarks Phase 3.A.1 only supports fixed-length arrays; variable-length slice
/// types (`[]T`) land in Phase 3.A.2 and will be a sibling symbol.
/// Instances are cached by (element, length) so that array types declared
/// with the same shape compare equal by reference.
class ArrayTypeSymbol : TypeSymbol {
    private init(elementType TypeSymbol, length int32) : base(
        "[$length]${elementType.Name}",
        NullableLifting.GetEffectiveClrType(elementType)?.MakeArrayType()
    ) {
        ElementType = elementType
        Length = length
    }

    /// Gets the element type.
    prop ElementType TypeSymbol {
        get;
    }

    /// Gets the fixed length of the array.
    prop Length int32 {
        get;
    }

    shared {
        private let Cache ConcurrentDictionary[
            (Element TypeSymbol, Length int32),
            ArrayTypeSymbol
        ] = ConcurrentDictionary[(Element TypeSymbol, Length int32), ArrayTypeSymbol]()

        /// Gets or creates the array type symbol for the given element type and length.
        /// @param elementType The element type.
        /// @param length The fixed array length.
        /// @returns The cached (cref:ArrayTypeSymbol).
        func Get(elementType TypeSymbol?, length int32) ArrayTypeSymbol {
            if elementType == nil {
                throw ArgumentNullException("elementType")
            }
            return Cache.GetOrAdd(
                (elementType, length),
                (key(Element TypeSymbol, Length int32)) -> ArrayTypeSymbol(key.Element, key.Length)
            )
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()
    }
}
