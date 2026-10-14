// <copyright file="SequenceTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Collections.Generic

/// Represents a sequence type `sequence[T]` — alias for `IEnumerable<T>` (ADR-0040).
class SequenceTypeSymbol : TypeSymbol {
    private init(elementType TypeSymbol) : base("sequence[${elementType.Name}]", MakeClrType(elementType)) {
        ElementType = elementType
    }

    /// Gets the element type.
    prop ElementType TypeSymbol {
        get;
    }

    shared {
        private let Cache ConcurrentDictionary[TypeSymbol, SequenceTypeSymbol] = ConcurrentDictionary[
            TypeSymbol,
            SequenceTypeSymbol
        ]()

        /// Gets or creates the sequence type symbol for the given element type.
        /// @param elementType The element type.
        /// @returns The cached (cref:SequenceTypeSymbol).
        func Get(elementType TypeSymbol?) SequenceTypeSymbol {
            if elementType == nil {
                throw ArgumentNullException("elementType")
            }
            return Cache.GetOrAdd(elementType, (et TypeSymbol) -> SequenceTypeSymbol(et))
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()

        /// Issue #3093: projects the G# sequence aliases and their CLR interface
        /// spellings onto one common generic-interface shape.
        /// @param type The type to inspect.
        /// @param openDefinition The matching `IEnumerable<>` or
        /// `IAsyncEnumerable<>` definition.
        /// @param elementType The symbolic element type.
        /// @returns `true` when [`type`](paramref) has a sequence-interface shape.
        internal func TryGetEnumerableInterfaceShape(
            type TypeSymbol,
            out openDefinition Type?,
            out elementType TypeSymbol
        ) bool {
            switch type {
                case sequence_ is SequenceTypeSymbol {
                    openDefinition = typeof(IEnumerable[_])
                    elementType = sequence_.ElementType
                    return true
                }
                case sequence_ is AsyncSequenceTypeSymbol {
                    openDefinition = typeof(IAsyncEnumerable[_])
                    elementType = sequence_.ElementType
                    return true
                }
                case imported is ImportedTypeSymbol when imported.OpenDefinition != nil &&
                    imported
                    .TypeArguments
                    .Length == 1 &&
                    IsEnumerableInterfaceDefinition(imported.OpenDefinition) {
                    openDefinition = imported.OpenDefinition
                    elementType = imported.TypeArguments[0]
                    return true
                }
            }
            let clrType Type? = type?.ClrType
            if clrType != nil && clrType.IsGenericType && !clrType.IsGenericTypeDefinition {
                let definition = clrType.GetGenericTypeDefinition()
                if IsEnumerableInterfaceDefinition(definition) {
                    openDefinition = definition
                    elementType = TypeSymbol.FromClrTypeWithoutNullability(
                        clrType.GetGenericArguments()[0],
                        NullabilityFreeReason.TypeStructure
                    )
                    return true
                }
            }
            openDefinition = nil
            // The value is ignored when the shape probe returns false.
            elementType = TypeSymbol.Error
            return false
        }

        private func MakeClrType(elementType TypeSymbol) Type? {
            let elementClrType Type? = NullableTypeSymbol.GetEffectiveClrType(elementType)
            if elementClrType == nil {
                return nil
            }
            return typeof(IEnumerable[_]).MakeGenericType(elementClrType)
        }

        private func IsEnumerableInterfaceDefinition(
            type Type?
        ) bool -> type?.FullName == "System.Collections.Generic.IEnumerable`1" ||
            type?.FullName == "System.Collections.Generic.IAsyncEnumerable`1"
    }
}
