// <copyright file="LoadContextSensitiveTypeComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Emit
import System
import System.Collections.Generic

/// Issue #3826 (the #3705 load-context family): compares (cref:Type)
/// instances the way (cref:TypeIdentityComparer) does — by structural
/// identity — but ADDITIONALLY requires that every assembly the type is built
/// from is the same (cref:System.Reflection.Assembly) INSTANCE.
/// @remarks (cref:TypeIdentityComparer) keys on
/// (cref:Type.AssemblyQualifiedName). Two copies of the same file loaded
/// into two different (cref:System.Runtime.Loader.AssemblyLoadContext)s
/// have the SAME assembly-qualified name, so that comparer treats them as one
/// type. That is exactly what #420 wanted for the emitter (collapsing duplicate
/// `TypeRef` rows for one logical type reached by several paths inside ONE
/// context), and exactly what a process-wide symbol cache must NOT do: it makes
/// a (cref:Type) from one compilation answer a later compilation's
/// lookup.
///
/// The dangerous case is a constructed generic whose DEFINITION lives in a
/// shared assembly but whose ARGUMENTS come from a private reference context —
/// `ImmutableArray<SyntaxNode>`, say. `ImportedTypeSymbol`'s
/// outer cache bucket is keyed by `type.Assembly`, which for both
/// constructions is the one host `System.Collections.Immutable`; only the
/// inner comparer separates them, and a name-only comparer does not. The
/// resulting cross-context symbol is silently wrong: closing a generic method
/// over an operand from each side makes
/// (cref:System.Reflection.MethodInfo.MakeGenericMethod) throw, overload
/// resolution drops the candidate per C# §7.5.2, and the call reports "Cannot
/// find function <name>" about a method that plainly exists (#3818).
///
/// Equality therefore keeps the structural check and adds a walk over the
/// type's constituents (element type, generic arguments) requiring
/// reference-equal assemblies at every position — the same "hash is a bucketing
/// hint, equality is the real test" shape as (cref:TypeArgsKey). Two
/// instances of one logical type reached by different paths inside a single
/// context still collapse, because a load context returns one
/// (cref:System.Reflection.Assembly) instance per identity.
internal class LoadContextSensitiveTypeComparer : IEqualityComparer[Type] {
    private init() { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Equals(x Type?, y Type?) bool {
        if object.ReferenceEquals(x, y) {
            return true
        }
        if x == nil || y == nil {
            return false
        }
        return TypeIdentityComparer.Instance.Equals(x, y) && SameAssemblyInstances(x, y)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func GetHashCode(obj Type) int32 -> TypeIdentityComparer.Instance.GetHashCode(obj)

    shared {
        /// The singleton instance.
        let Instance LoadContextSensitiveTypeComparer = LoadContextSensitiveTypeComparer()

        /// Walks two structurally identical types in parallel, requiring the same
        /// (cref:System.Reflection.Assembly) instance at every position.
        /// @param x The first type.
        /// @param y The second type, structurally equal to [`x`](paramref).
        /// @returns `true` when both are built from the same assembly instances.
        private func SameAssemblyInstances(x Type, y Type) bool {
            if object.ReferenceEquals(x, y) {
                return true
            }
            if !object.ReferenceEquals(x.Assembly, y.Assembly) {
                return false
            }
            if x.HasElementType && y.HasElementType {
                let xElement Type? = x.GetElementType()
                let yElement Type? = y.GetElementType()
                if xElement != nil && yElement != nil && !SameAssemblyInstances(xElement, yElement) {
                    return false
                }
            }
            // Structural equality already guarantees matching arity; the length
            // guard keeps this total for the pathological reflection shapes
            // (generic parameters, function pointers) that report otherwise.
            let xArguments = x.GenericTypeArguments
            let yArguments = y.GenericTypeArguments
            if xArguments.Length != yArguments.Length {
                return false
            }
            for var i = 0; i < xArguments.Length; i++ {
                if !SameAssemblyInstances(xArguments[i], yArguments[i]) {
                    return false
                }
            }
            return true
        }
    }
}
