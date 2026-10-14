// <copyright file="ByRefTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent

/// Represents a managed by-ref pointer type `*T` (CLR `ELEMENT_TYPE_BYREF`).
/// Instances are interned per pointee type for identity equality.
class ByRefTypeSymbol : TypeSymbol {
    private init(pointeeType TypeSymbol) : base("*${pointeeType.Name}", pointeeType.ClrType?.MakeByRefType()) {
        PointeeType = pointeeType
    }

    /// Gets the pointee (element) type that this by-ref pointer refers to.
    prop PointeeType TypeSymbol {
        get;
    }

    shared {
        private let Cache ConcurrentDictionary[TypeSymbol, ByRefTypeSymbol] = ConcurrentDictionary[
            TypeSymbol,
            ByRefTypeSymbol
        ]()

        /// Gets or creates the interned (cref:ByRefTypeSymbol) for the given pointee type.
        /// @param pointeeType The type being pointed to.
        /// @returns The cached (cref:ByRefTypeSymbol).
        func Get(pointeeType TypeSymbol?) ByRefTypeSymbol {
            if pointeeType == nil {
                throw ArgumentNullException("pointeeType")
            }
            return Cache.GetOrAdd(pointeeType, (pt TypeSymbol) -> ByRefTypeSymbol(pt))
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()
    }
}
