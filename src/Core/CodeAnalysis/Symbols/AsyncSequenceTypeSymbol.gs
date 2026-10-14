// <copyright file="AsyncSequenceTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Collections.Generic

/// Represents an async sequence type — the contextual alias for
/// `System.Collections.Generic.IAsyncEnumerable<T>` produced when
/// `sequence[T]` appears in the return-type position of an
/// `async func` (ADR-0041). Outside the return-type position of an
/// `async func`, `sequence[T]` still resolves to the synchronous
/// (cref:SequenceTypeSymbol) (ADR-0040).
class AsyncSequenceTypeSymbol : TypeSymbol {
    private init(elementType TypeSymbol) : base("sequence[${elementType.Name}]", MakeClrType(elementType)) {
        ElementType = elementType
    }

    /// Gets the element type.
    prop ElementType TypeSymbol {
        get;
    }

    shared {
        private let Cache ConcurrentDictionary[TypeSymbol, AsyncSequenceTypeSymbol] = ConcurrentDictionary[
            TypeSymbol,
            AsyncSequenceTypeSymbol
        ]()

        /// Gets or creates the async-sequence type symbol for the given element type.
        /// @param elementType The element type.
        /// @returns The cached (cref:AsyncSequenceTypeSymbol).
        func Get(elementType TypeSymbol?) AsyncSequenceTypeSymbol {
            if elementType == nil {
                throw ArgumentNullException("elementType")
            }
            return Cache.GetOrAdd(elementType, (et TypeSymbol) -> AsyncSequenceTypeSymbol(et))
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()

        private func MakeClrType(elementType TypeSymbol) Type? {
            let elementClrType Type? = NullableTypeSymbol.GetEffectiveClrType(elementType)
            if elementClrType == nil {
                return nil
            }
            return typeof(IAsyncEnumerable[_]).MakeGenericType(elementClrType)
        }
    }
}
