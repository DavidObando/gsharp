// <copyright file="PlatformTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent

/// ADR-0186 §1: the <b>platform type</b> `T!` — a reference position whose
/// nullability nobody stated.
///
/// A (cref:NullableTypeSymbol) means "the declarer said this may be
/// nil". A bare (cref:TypeSymbol) means "the declarer said this is never
/// nil". (cref:PlatformTypeSymbol) is the third answer, and the only
/// honest one for a position imported from nullability-<em>oblivious</em> CLR
/// metadata: <em>the declarer said nothing</em>. ADR-0136 collapsed that third
/// answer onto `T?`, which is what forced every use site to discharge a
/// proof obligation about a fact the compiler does not have — and what
/// bound-node carve-out predicates were reconstructing for oblivious
/// receivers, one node kind at a time. With this symbol an oblivious receiver
/// no longer depends on any of them. (The last such predicate on `main`,
/// `CanBindClrInstanceMember`'s `BoundClrPropertyAccessExpression`
/// disjunct, outlived step 4 because it also carried member chains through
/// stated-nullable imported reads; issue #4356 deleted it.)
///
/// The wrapper is deliberately a <b>distinct symbol</b> rather than a flag on
/// (cref:NullableTypeSymbol) (ADR-0186 alternative 2). The sites that
/// must not treat a platform value as nullable — member lookup, overload
/// resolution, GS0159 — simply never match `is NullableTypeSymbol`, and
/// they do so <em>by construction</em> rather than by each remembering to ask a
/// predicate. It is equally deliberately <b>not</b> an erasure to `T`:
/// `T!` must still admit `== nil`, `if let`, `?.` and
/// `!!`, and erasing it would reinstate verbatim the hole ADR-0136 closed.
///
/// It is <b>never writable in source</b>. No syntax produces one; it is
/// produced by exactly one mechanism (ADR-0186 §2 — `ClrNullability`'s
/// three reading paths, for a position whose nullability byte is oblivious) and
/// appears only in diagnostics, hover text and `DisplayFormat` output,
/// spelled `T!`.
///
/// Like (cref:NullableTypeSymbol) the wrapper is purely a binder-level
/// annotation: (cref:TypeSymbol.ClrType) is the underlying type's, and
/// emit erases the wrapper to `T`.
/// @remarks ADR-0186 step 1 built the symbol and its read path behind
/// `--nullability=platform-types`; step 3 made that mode the <b>default</b>
/// ((cref:NullabilityOptions)), so an ordinary compilation constructs
/// these wrappers for every oblivious imported reference position.
/// `--nullability=enabled` restores ADR-0136's reading, and under it
/// nothing constructs one.
class PlatformTypeSymbol : TypeSymbol {
    private init(underlyingType TypeSymbol) : base(ComputeDisplayName(underlyingType), underlyingType.ClrType) {
        UnderlyingType = underlyingType
    }

    /// Gets the underlying type whose nullability was never stated.
    prop UnderlyingType TypeSymbol {
        get;
    }

    shared {
        /// Reference-identity cache, mirroring (cref:NullableTypeSymbol)'s.
        ///
        /// This is not an optimisation. `SymbolEqualityComparer.Default` is
        /// `ReferenceEquals` and G# symbols are reference-unique within a
        /// compilation, so two independently-constructed wrappers over the same
        /// underlying type would be two <em>different</em> types to every symbol
        /// set, dictionary and identity comparison in the binder. De-duplicating
        /// here is what makes `T!` a type rather than a family of
        /// indistinguishable look-alikes.
        private let Cache ConcurrentDictionary[TypeSymbol, PlatformTypeSymbol] = ConcurrentDictionary[
            TypeSymbol,
            PlatformTypeSymbol
        ]()

        /// Returns the platform type `T!` over the given underlying type,
        /// normalised exactly as (cref:NullableTypeSymbol.Get) is, in the
        /// mirror direction (ADR-0193 §2).
        /// - Wrapping a (cref:PlatformTypeSymbol) is a no-op.
        /// - Wrapping a (cref:NullableTypeSymbol) returns it unchanged: an explicit statement always beats the
        /// absence of one (ADR-0186 §3), so `T?!` is `T?`. With (cref:NullableTypeSymbol.Get)'s own
        /// normalisation, neither `T?!` nor `T!?` can be constructed.
        /// - Wrapping a value type returns it unchanged: `T!` is a statement about a reference position, and a
        /// value type has no reference nullability to leave unstated. "Value type" is
        /// (cref:NullabilityImportRule.ClassifyArgument(TypeSymbol))'s answer, the same classifier the import
        /// rule uses.
        /// @param underlyingType The underlying reference type.
        /// @returns A cached platform wrapper, or [`underlyingType`](paramref) itself
        /// when one of the normalisations above applies.
        func Get(underlyingType TypeSymbol) TypeSymbol {
            if underlyingType is PlatformTypeSymbol ||
                underlyingType is NullableTypeSymbol ||
                NullabilityImportRule.ClassifyArgument(underlyingType) == TypeArgumentKind.Value {
                return underlyingType
            }
            return Cache.GetOrAdd(underlyingType, (t TypeSymbol) -> PlatformTypeSymbol(t))
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) alongside
        /// (cref:NullableTypeSymbol.ClearCache) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()

        /// Reads through a top-level platform wrapper: [`type`](paramref)'s
        /// underlying type when it is `T!`, and [`type`](paramref)
        /// itself otherwise.
        ///
        /// For the <b>structural</b> questions the binder and lowerer ask of a
        /// declared type — "is this an iterator return type, and of what?", "is
        /// this a task, and what does it await?" — `T!` is `T`: whether
        /// the value itself may be nil says nothing about its shape. ADR-0186 §9
        /// is what makes this routine, because every unadorned reference a G#
        /// declaration writes inside an oblivious scope is wrapped, including an
        /// iterator's `IEnumerable[string]` and an async function's
        /// `Task[string]`. Those helpers match on the symbolic shape first
        /// (`is ImportedTypeSymbol`, `is SequenceTypeSymbol`) and fall
        /// back to the erased `ClrType`, so without this a wrapped
        /// `IEnumerable[string!]` silently answered `string` — and
        /// every `yield` of an oblivious value was coerced to non-null.
        /// @param type The type to read through.
        /// @returns The type with any top-level platform wrapper removed.
        internal func StripTopLevel(type TypeSymbol) TypeSymbol -> if type is PlatformTypeSymbol platform {
            platform.UnderlyingType
        } else {
            type
        }

        /// ADR-0186 §1 / ADR-0132: the `!` follows the same <b>positional</b>
        /// rule as (cref:NullableTypeSymbol)'s `?`, and it needs a
        /// parallel implementation rather than falling out for free.
        ///
        /// A platform array/slice must render with the `!` bound to the array
        /// itself (`[]!T` / `[N]!T`) so its display name is distinct from
        /// a slice of platform elements (`[]T!` =
        /// `Slice(Platform(T))`) — the exact distinction ADR-0132 draws for
        /// `[]?T` versus `[]T?`. A platform function type wraps the whole
        /// arrow shape in parentheses (`((int32) -> void)!`) so the
        /// `!` applies to the function type and not just its return type. For
        /// every other underlying type the marker trails the name (`T!`).
        /// @param underlyingType The underlying type.
        /// @returns The G# display name for the platform wrapper.
        private func ComputeDisplayName(underlyingType TypeSymbol) string {
            return switch underlyingType {
                case slice is SliceTypeSymbol: "[]!${slice.ElementType.Name}"
                case array is ArrayTypeSymbol: "[${array.Length}]!${array.ElementType.Name}"
                case array is RectangularArrayTypeSymbol: "[${String(',', array.Rank - 1)}]!${array.ElementType.Name}"
                case function is FunctionTypeSymbol: "(${function.Name})!"
                default: underlyingType.Name + "!"
            }
        }
    }
}
