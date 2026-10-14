// <copyright file="AsyncIteratorDetection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System

/// Single source of truth for "is this an async iterator?" detection and
/// element-type extraction across the async/iterator lowering pipeline.
/// @remarks Issue #1489: the async-iterator pipeline historically carried three
/// divergent copies of this predicate. The (cref:Iterators.AsyncIteratorRewriter)
/// recognised the symbolic (cref:AsyncSequenceTypeSymbol) form (issue
/// #798) and the open (cref:ImportedTypeSymbol) form (issue #1002),
/// while (cref:AsyncStateMachineRewriter) and
/// (cref:AsyncEmitPrecheck) keyed off a <em>closed</em> CLR
/// `IAsyncEnumerable`1` / `IAsyncEnumerator`1` return type only.
///
/// For a GENERIC async iterator (`async func gen[T](x T) sequence[T]`)
/// the return type is an (cref:AsyncSequenceTypeSymbol) over an open
/// type parameter whose (cref:TypeSymbol.ClrType) is `null`,
/// so the CLR-only copies failed to recognise it. The function was then
/// mis-routed into the plain-async state-machine pass (where the method builder
/// could not be resolved) and ultimately reported as `GS0190`. Routing
/// every site through this helper keeps the three checks in lock-step so the
/// symbolic open-generic form is recognised consistently.
///
/// Issue #2786: an explicitly async iterator remains an iterator when its
/// body has no `yield`; plain-async lowering would spuriously change its
/// runtime return type to `Task<IAsyncEnumerable<T>>`.
shared class AsyncIteratorDetection {
    /// Determines whether [`function`](paramref) is an async iterator —
    /// one that is explicitly async or contains `yield`, and whose declared return type is `sequence[T]`
    /// ((cref:AsyncSequenceTypeSymbol)) or
    /// `IAsyncEnumerable[T]` / `IAsyncEnumerator[T]` in any of its
    /// closed-CLR, open-imported, or user-element forms.
    /// @param function The function symbol to inspect.
    /// @param body The function's bound body.
    /// @returns `true` when the function is an async iterator.
    func IsAsyncIteratorFunction(function FunctionSymbol?, body BoundStatement) bool -> function != nil &&
        GetElementType(function.Type) != nil &&
        (function.IsAsync || IteratorDetection.ContainsYield(body))

    /// Determines whether [`type`](paramref) is an async-iterator return
    /// type (see (cref:IsAsyncIteratorFunction)).
    /// @param type The candidate return type.
    /// @returns `true` when the type is an async-iterator return type.
    func IsAsyncIteratorReturnType(type TypeSymbol) bool -> GetElementType(type) != nil

    /// Determines whether [`type`](paramref) is an
    /// `IAsyncEnumerable[T]` async-iterator return type (as opposed to
    /// `IAsyncEnumerator[T]`) — only the enumerable form exposes
    /// `GetAsyncEnumerator`. Recognises the symbolic `sequence[T]`
    /// alias ((cref:AsyncSequenceTypeSymbol)) and the open
    /// (cref:ImportedTypeSymbol) form so an open type parameter is not
    /// misclassified via the null/erased CLR projection (issue #1489).
    /// @param type The candidate async-iterator return type.
    /// @returns `true` for the enumerable form.
    func IsAsyncEnumerable(type TypeSymbol) bool {
        var type = type
        // ADR-0186 §9: see PlatformTypeSymbol.StripTopLevel.
        type = PlatformTypeSymbol.StripTopLevel(type)
        // sequence[T] in an async return position aliases IAsyncEnumerable<T>.
        if type is AsyncSequenceTypeSymbol {
            return true
        }
        if type is ImportedTypeSymbol imported &&
            imported
            .OpenDefinition
            ?.FullName == "System.Collections.Generic.IAsyncEnumerable`1" {
            return true
        }
        let clr Type? = type?.ClrType
        if clr == nil || !clr.IsGenericType {
            return false
        }
        return clr.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1"
    }

    /// Extracts the element type from an async-iterator return type, honouring
    /// the symbolic forms (issue #798 (cref:AsyncSequenceTypeSymbol),
    /// issue #1002 open (cref:ImportedTypeSymbol)) so an open type
    /// parameter is preserved rather than collapsed to `object` via the
    /// CLR-erased projection.
    /// @param type The candidate async-iterator return type.
    /// @returns The element type, or `null` when
    /// [`type`](paramref) is not an async-iterator return type.
    func GetElementType(type TypeSymbol) TypeSymbol? {
        var type = type
        // ADR-0186 §9: see PlatformTypeSymbol.StripTopLevel.
        type = PlatformTypeSymbol.StripTopLevel(type)
        // Issue #798: `async sequence[T]` (AsyncSequenceTypeSymbol) carries
        // its element symbolically; honor it directly so an open T does not
        // collapse via the ClrType branch.
        if type is AsyncSequenceTypeSymbol aseq {
            return aseq.ElementType
        }
        // Issue #1002 (parallel to #990): `IAsyncEnumerable[Shape]` /
        // `IAsyncEnumerator[Shape]` where `Shape` is a same-compilation user
        // class — or any open type parameter — is modelled as an
        // ImportedTypeSymbol carrying the element symbolically in
        // `TypeArguments`. Its `ClrType` is the erased
        // `IAsyncEnumerable<object>`; honour the symbolic argument so the
        // state machine emits the strongly-typed interface rows.
        if type is ImportedTypeSymbol imported &&
            imported.OpenDefinition != nil &&
            !imported
            .TypeArguments
            .IsDefaultOrEmpty &&
            imported
            .TypeArguments
            .Length == 1 &&
            (
            imported
                .OpenDefinition
                .FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                imported
                .OpenDefinition
                .FullName == "System.Collections.Generic.IAsyncEnumerator`1"
        ) {
            return imported.TypeArguments[0]
        }
        let clr Type? = type?.ClrType
        if clr == nil || !clr.IsGenericType || clr.IsGenericTypeDefinition {
            return nil
        }
        let def = clr.GetGenericTypeDefinition()
        let fullName = def?.FullName
        if fullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
            fullName == "System.Collections.Generic.IAsyncEnumerator`1" {
            return TypeSymbol.FromClrTypeWithoutNullability(
                clr.GetGenericArguments()[0],
                NullabilityFreeReason.TypeStructure
            )
        }
        return nil
    }
}
