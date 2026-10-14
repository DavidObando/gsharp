// <copyright file="SliceTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent

/// Represents a variable-length slice type `[]T`.
/// @remarks Phase 3.A.2 / ADR-0016 — backing representation is the CLR
/// single-dimensional zero-based array `T[]`. `len(s)` and
/// `cap(s)` both return `s.Length`; `append(s, v)`
/// allocates a new array of length `+1`, copies, and writes the
/// new element. Full Go slice header semantics (independent
/// length/capacity, aliased backing array) are intentionally deferred.
/// Instances are cached per element type so identical slice types
/// compare by reference.
class SliceTypeSymbol : TypeSymbol {
    private init(elementType TypeSymbol) : base(
        "[]${elementType.Name}",
        NullableLifting.GetEffectiveClrType(elementType)?.MakeArrayType()
    ) {
        ElementType = elementType
    }

    /// Gets the element type.
    prop ElementType TypeSymbol {
        get;
    }

    shared {
        private let Cache ConcurrentDictionary[TypeSymbol, SliceTypeSymbol] = ConcurrentDictionary[
            TypeSymbol,
            SliceTypeSymbol
        ]()

        /// Gets or creates the slice type symbol for the given element type.
        /// @param elementType The element type.
        /// @returns The cached (cref:SliceTypeSymbol).
        func Get(elementType TypeSymbol?) SliceTypeSymbol {
            if elementType == nil {
                throw ArgumentNullException("elementType")
            }
            return Cache.GetOrAdd(elementType, (e TypeSymbol) -> SliceTypeSymbol(e))
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()
    }
}
