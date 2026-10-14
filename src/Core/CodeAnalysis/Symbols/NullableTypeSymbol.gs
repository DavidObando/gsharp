// <copyright file="NullableTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent

/// Phase 3.C.1 / ADR-0001: wraps an underlying (cref:TypeSymbol) to
/// indicate that values of this type may be the absence-of-value (nil).
/// @remarks In Phase 3.C.1 the wrapper is purely a binder-level annotation: emit and
/// the evaluator treat (cref:UnderlyingType) as the runtime type. The
/// nil literal, null-safe operators, and smart casts follow in Phase 3.C.2–4.
class NullableTypeSymbol : TypeSymbol {
    private init(underlyingType TypeSymbol) : base(ComputeDisplayName(underlyingType), underlyingType.ClrType) {
        UnderlyingType = underlyingType
    }

    /// Gets the non-nullable underlying type.
    prop UnderlyingType TypeSymbol {
        get;
    }

    shared {
        private let Cache ConcurrentDictionary[TypeSymbol, NullableTypeSymbol] = ConcurrentDictionary[
            TypeSymbol,
            NullableTypeSymbol
        ]()

        /// Returns the cached (cref:NullableTypeSymbol) wrapping the given underlying type.
        /// @param underlyingType The non-nullable underlying type.
        /// @returns A cached nullable wrapper. Wrapping a (cref:NullableTypeSymbol) is a no-op.
        func Get(underlyingType TypeSymbol) NullableTypeSymbol {
            var underlyingType = underlyingType
            if underlyingType is NullableTypeSymbol already {
                return already
            }
            // ADR-0186: `T!?` is not a type this language has. Wrapping a platform
            // type in `?` produces plain `T?`, by §3's governing principle — an
            // explicit statement always beats the absence of one, which is the
            // same rule that makes lub(`T!`, `T?`) be `T?`.
            //
            // Normalising HERE rather than at each caller is deliberate. The
            // wrapper is applied at every result-lifting site in the language —
            // `?.`, `?[`, a nil switch arm, a lifted operator — and three of
            // those were independently producing `Nullable(Platform(U))` for an
            // oblivious member. A `U!?` is not merely cosmetic: it is not a
            // `NullableTypeSymbol` over the underlying that narrowing, `??` and
            // `if let` expect, so platform-ness survived a guarded access and
            // leaked into everything downstream of it. One normalisation point
            // is the only version of this that cannot drift.
            if underlyingType is PlatformTypeSymbol platform {
                underlyingType = platform.UnderlyingType
            }
            return Cache.GetOrAdd(underlyingType, (t TypeSymbol) -> NullableTypeSymbol(t))
        }

        /// Issue #530: returns the effective CLR (cref:Type) to use when
        /// matching [`typeSymbol`](paramref) as a method argument in overload
        /// resolution. For a (cref:NullableTypeSymbol) wrapping a value
        /// type, this returns `Nullable<T>` rather than the underlying
        /// `T`, because the emitter encodes the local as `Nullable<T>`
        /// and the selected overload must accept that type on the evaluation stack.
        /// For all other types the result equals `typeSymbol?.ClrType`.
        /// @param typeSymbol The type symbol to resolve.
        /// @returns The CLR (cref:Type) to use for overload resolution, or `null` if [`typeSymbol`](paramref)
        /// is `null`.
        func GetEffectiveClrType(typeSymbol TypeSymbol?) Type? -> NullableLifting.GetEffectiveClrType(typeSymbol)

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()

        /// Issue #1212: a nullable array/slice must render with the `?` bound to
        /// the array itself (`[]?T` / `[N]?T`) so its display name is distinct
        /// from an array of nullable elements (`[]T?` = `Slice(Nullable(T))`).
        /// Issue #2160: a nullable function type must wrap the whole arrow shape in
        /// parentheses (`((int32) -> void)?`) so the `?` applies to the
        /// function type and not just its return type (never `(int32) -> void?`).
        /// For all other underlying types the nullable marker trails the name (`T?`).
        /// @param underlyingType The non-nullable underlying type.
        /// @returns The G# display name for the nullable wrapper.
        private func ComputeDisplayName(underlyingType TypeSymbol) string {
            return switch underlyingType {
                case slice is SliceTypeSymbol: "[]?${slice.ElementType.Name}"
                case array is ArrayTypeSymbol: "[${array.Length}]?${array.ElementType.Name}"
                case array is RectangularArrayTypeSymbol: "[${String(',', array.Rank - 1)}]?${array.ElementType.Name}"
                case function is FunctionTypeSymbol: "(${function.Name})?"
                default: underlyingType.Name + "?"
            }
        }
    }
}
