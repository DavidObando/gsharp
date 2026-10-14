// <copyright file="PointerTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent

/// Represents an <em>unmanaged</em> raw pointer type `*T` (CLR
/// `ELEMENT_TYPE_PTR`, the faithful mapping of C# `T*`). Distinct from
/// (cref:ByRefTypeSymbol), which models a <em>managed</em> by-ref pointer
/// (`ELEMENT_TYPE_BYREF`, `T&`). Unmanaged pointers are only legal
/// inside an `unsafe` context (ADR-0122 / issue #1014); unlike managed
/// by-refs they may be stored in fields, declared as locals, and passed as plain
/// (non-ref-kind) P/Invoke parameters.
/// @remarks Instances are interned per pointee type for identity equality, mirroring
/// (cref:ByRefTypeSymbol).
class PointerTypeSymbol : TypeSymbol {
    private init(pointeeType TypeSymbol) : base("*${pointeeType.Name}", pointeeType.ClrType?.MakePointerType()) {
        PointeeType = pointeeType
    }

    /// Gets the pointee (element) type that this unmanaged pointer refers to.
    prop PointeeType TypeSymbol {
        get;
    }

    shared {
        private let Cache ConcurrentDictionary[TypeSymbol, PointerTypeSymbol] = ConcurrentDictionary[
            TypeSymbol,
            PointerTypeSymbol
        ]()

        /// Gets or creates the interned (cref:PointerTypeSymbol) for the given pointee type.
        /// @param pointeeType The type being pointed to.
        /// @returns The cached (cref:PointerTypeSymbol).
        func Get(pointeeType TypeSymbol?) PointerTypeSymbol {
            if pointeeType == nil {
                throw ArgumentNullException("pointeeType")
            }
            return Cache.GetOrAdd(pointeeType, (pt TypeSymbol) -> PointerTypeSymbol(pt))
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()
    }
}
