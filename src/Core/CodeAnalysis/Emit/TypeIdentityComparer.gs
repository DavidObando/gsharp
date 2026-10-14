// <copyright file="TypeIdentityComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Runtime.CompilerServices

/// Issue #420 (P3-9): compares (cref:Type) instances by structural
/// identity (assembly-qualified name) rather than reference equality.
///
/// The emitter resolves CLR (cref:Type) objects through
/// (cref:System.Reflection.MetadataLoadContext). The same logical type
/// can be returned as two distinct (cref:Type) instances when it is
/// reached through different reference paths (e.g. via different
/// MetadataLoadContext lookups for the same assembly identity, or when the
/// same type is observed both from a directly loaded assembly and from a
/// transitively loaded one). Reference-equality-keyed caches then mint a
/// duplicate `TypeRef` row for each occurrence, producing valid but
/// bloated metadata that tools like ILSpy render as separate rows.
///
/// Using assembly-qualified name as the identity key collapses these
/// duplicates into a single cache entry — and therefore a single `TypeRef`
/// row — without affecting types that genuinely differ.
internal class TypeIdentityComparer : IEqualityComparer[Type] {
    private init() { }

    func Equals(x Type?, y Type?) bool {
        if object.ReferenceEquals(x, y) {
            return true
        }
        if x == nil || y == nil {
            return false
        }
        let keyX = GetKey(x)
        let keyY = GetKey(y)
        return string.Equals(keyX, keyY, StringComparison.Ordinal)
    }

    func GetHashCode(obj Type?) int32 {
        if obj == nil {
            throw ArgumentNullException("obj")
        }
        return StringComparer.Ordinal.GetHashCode(GetKey(obj))
    }

    shared {
        let Instance TypeIdentityComparer = TypeIdentityComparer()

        /// Issue #1679: process-wide memoization of (cref:GetKey), keyed by
        /// the CLR (cref:Type) instance. `TypeRefs`/`TypeSpecs`
        /// (see (cref:MetadataTokenCache)) are keyed by this comparer, so
        /// every dictionary probe — including cache hits — used to rebuild the
        /// type's assembly-qualified name from scratch; for a constructed generic
        /// like `Dictionary<string, List<Foo>>` that string is
        /// built recursively and is invoked many times per emitted method body
        /// (casts, boxes, array creations, local signatures, member-ref parents).
        /// A (cref:ConditionalWeakTable{TKey, TValue}) keyed on the
        /// (cref:Type) itself lets repeated probes for the same Type
        /// instance reuse the already-computed key without allocating a new
        /// string, while still comparing/hashing distinct Type instances that
        /// describe the same logical type by their (now-cached) AQN string. Being
        /// weakly keyed, entries are collected automatically once the owning
        /// (cref:System.Reflection.MetadataLoadContext)'s Type instances
        /// become unreachable, so — unlike the process-wide caches added for
        /// #1622 — this table needs no explicit `ClearCache`/Dispose wiring
        /// to avoid pinning a disposed context.
        private let KeyCache ConditionalWeakTable[Type, string] = ConditionalWeakTable[Type, string]()

        private func GetKey(type Type) string {
            // AssemblyQualifiedName encodes namespace, name (including nesting
            // via '+'), generic arity, generic arguments, array/pointer/byref
            // suffixes, and the full assembly identity. That makes it a
            // faithful structural key: two Type instances that describe the
            // same logical type from different MetadataLoadContext paths
            // share the same string here. Fall back to FullName/Name when
            // AssemblyQualifiedName is unavailable (e.g. generic type
            // parameters), preferring the most specific identifier we can
            // build.
            return KeyCache.GetValue(type, (t Type) -> t.AssemblyQualifiedName ?? t.FullName ?? t.Name)
        }
    }
}
