// <copyright file="AsyncReturnTypeNormalizer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Diagnostics.CodeAnalysis
import System.Threading.Tasks

/// Issue #1071: helpers for comparing the <em>effective</em> (post-async-
/// normalization) return type of a method against a base / interface method.
/// An `async func M()` with no return annotation has declared return type
/// `void` but an effective return type of `Task`; an
/// `async func M() T` has declared return type `T` but an effective
/// return type of `Task[T]`. The override-matching and interface-
/// satisfaction comparisons must use the effective return type so an async
/// method validly overrides / implements a base declared with the explicit
/// `Task` / `Task[T]` return type.
internal shared class AsyncReturnTypeNormalizer {
    /// Returns the declared result represented by a call-site return type.
    /// Async calls carry one observable Task/ValueTask wrapper, which is
    /// removed exactly once; all other calls and shapes pass through.
    /// @param function The called function.
    /// @param callSiteReturnType The bound call's observable return type.
    /// @returns The declared result type used for generic substitution.
    func GetDeclaredResultType(
        function FunctionSymbol,
        callSiteReturnType TypeSymbol
    ) TypeSymbol -> if function?.IsAsync == true &&
        TryUnwrapTaskReturnType(callSiteReturnType, out var declaredResult) {
        declaredResult!!
    } else {
        callSiteReturnType
    }

    /// Unwraps the awaited result of a `Task` / `Task[T]` /
    /// `ValueTask` / `ValueTask[T]` return type symbol: the
    /// non-generic forms resolve to (cref:TypeSymbol.Void), the generic
    /// forms to their result-type argument. Returns `false` for any other
    /// shape (so a genuine non-Task return type is never spuriously matched
    /// against an async method).
    /// @param type The (declared) return type symbol to unwrap.
    /// @param awaited The unwrapped awaited result type, when this returns `true`.
    /// @returns `true` when [`type`](paramref) is a Task / ValueTask shape.
    func TryUnwrapTaskReturnType(
        type TypeSymbol,
        @NotNullWhen(true) out awaited TypeSymbol?
    ) bool -> TryUnwrapTaskReturnType(type, out awaited, out _)

    /// Issue #1918: same as the two-parameter overload above,
    /// but also reports whether the unwrapped shape was a `ValueTask` /
    /// `ValueTask[T]` (as opposed to a `Task` / `Task[T]`) —
    /// the async-function declaration binder needs this to select the
    /// matching state-machine builder / observable return type.
    /// @param type The (declared) return type symbol to unwrap.
    /// @param awaited The unwrapped awaited result type, when this returns `true`.
    /// @param isValueTask `true` when the unwrapped shape was `ValueTask` / `ValueTask[T]`.
    /// @returns `true` when [`type`](paramref) is a Task / ValueTask shape.
    func TryUnwrapTaskReturnType(
        type TypeSymbol?,
        @NotNullWhen(true) out awaited TypeSymbol?,
        out isValueTask bool
    ) bool {
        var type = type
        awaited = nil
        isValueTask = false
        if type == nil {
            return false
        }
        // ADR-0186 §9: an async function declared in an oblivious scope has a
        // platform-typed return (`Task[string!]!`). Whether the TASK itself
        // may be nil says nothing about what it awaits, so read through the
        // wrapper — and read the symbolic argument below, not the erased
        // `ClrType`, or the awaited `string!` silently becomes `string` and
        // every `return` of an oblivious value is coerced to non-null.
        type = PlatformTypeSymbol.StripTopLevel(type)
        // #313 symbolic construction: a Task[T] / ValueTask[T] over an in-scope
        // generic type parameter is type-erased in its ClrType, so recover the
        // symbolic result argument from the open definition + type arguments.
        if type is ImportedTypeSymbol imported &&
            imported.OpenDefinition != nil &&
            !imported
            .TypeArguments
            .IsDefaultOrEmpty &&
            imported
            .TypeArguments
            .Length == 1 {
            let openName = imported.OpenDefinition.FullName
            if openName == "System.Threading.Tasks.Task`1" || openName == "System.Threading.Tasks.ValueTask`1" {
                awaited = imported.TypeArguments[0]
                isValueTask = openName == "System.Threading.Tasks.ValueTask`1"
                return true
            }
        }
        let clr Type? = type.ClrType
        if clr == nil {
            return false
        }
        if clr.IsSameAs(typeof(Task)) || clr.IsSameAs(typeof(ValueTask)) {
            awaited = TypeSymbol.Void
            isValueTask = clr.IsSameAs(typeof(ValueTask))
            return true
        }
        if clr.IsGenericType && !clr.IsGenericTypeDefinition {
            let definition = clr.GetGenericTypeDefinition()
            if definition.IsSameAs(typeof(Task[_])) || definition.IsSameAs(typeof(ValueTask[_])) {
                awaited = TypeSymbol.FromClrTypeWithoutNullability(
                    clr.GetGenericArguments()[0],
                    NullabilityFreeReason.TypeStructure
                )
                isValueTask = definition.IsSameAs(typeof(ValueTask[_]))
                return true
            }
        }
        return false
    }

    /// CLR-type companion to (cref:TryUnwrapTaskReturnType(TypeSymbol, out TypeSymbol)): unwraps the
    /// awaited result of a `Task` / `Task<T>` / `ValueTask`
    /// / `ValueTask<T>` CLR return type (the non-generic forms resolve
    /// to `typeof(void)`). Used for matching an async method against an
    /// imported CLR interface method whose contract carries the explicit
    /// `Task` return type. Returns `false` for any other shape.
    /// @param type The CLR return type to unwrap.
    /// @param awaited The unwrapped awaited CLR result type, when this returns `true`.
    /// @returns `true` when [`type`](paramref) is a Task / ValueTask shape.
    func TryUnwrapTaskClrType(type Type?, @NotNullWhen(true) out awaited Type?) bool {
        awaited = nil
        if type == nil {
            return false
        }
        if type.IsSameAs(typeof(Task)) || type.IsSameAs(typeof(ValueTask)) {
            awaited = typeof(Void)
            return true
        }
        if type.IsGenericType && !type.IsGenericTypeDefinition {
            let definition = type.GetGenericTypeDefinition()
            if definition.IsSameAs(typeof(Task[_])) || definition.IsSameAs(typeof(ValueTask[_])) {
                awaited = type.GetGenericArguments()[0]
                return true
            }
        }
        return false
    }
}
