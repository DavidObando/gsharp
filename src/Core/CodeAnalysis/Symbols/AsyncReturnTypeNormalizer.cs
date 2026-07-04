// <copyright file="AsyncReturnTypeNormalizer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading.Tasks;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #1071: helpers for comparing the <em>effective</em> (post-async-
/// normalization) return type of a method against a base / interface method.
/// An <c>async func M()</c> with no return annotation has declared return type
/// <c>void</c> but an effective return type of <c>Task</c>; an
/// <c>async func M() T</c> has declared return type <c>T</c> but an effective
/// return type of <c>Task[T]</c>. The override-matching and interface-
/// satisfaction comparisons must use the effective return type so an async
/// method validly overrides / implements a base declared with the explicit
/// <c>Task</c> / <c>Task[T]</c> return type.
/// </summary>
internal static class AsyncReturnTypeNormalizer
{
    /// <summary>
    /// Unwraps the awaited result of a <c>Task</c> / <c>Task[T]</c> /
    /// <c>ValueTask</c> / <c>ValueTask[T]</c> return type symbol: the
    /// non-generic forms resolve to <see cref="TypeSymbol.Void"/>, the generic
    /// forms to their result-type argument. Returns <c>false</c> for any other
    /// shape (so a genuine non-Task return type is never spuriously matched
    /// against an async method).
    /// </summary>
    /// <param name="type">The (declared) return type symbol to unwrap.</param>
    /// <param name="awaited">The unwrapped awaited result type, when this returns <c>true</c>.</param>
    /// <returns><c>true</c> when <paramref name="type"/> is a Task / ValueTask shape.</returns>
    public static bool TryUnwrapTaskReturnType(TypeSymbol type, out TypeSymbol awaited)
        => TryUnwrapTaskReturnType(type, out awaited, out _);

    /// <summary>
    /// Issue #1918: same as the two-parameter overload above,
    /// but also reports whether the unwrapped shape was a <c>ValueTask</c> /
    /// <c>ValueTask[T]</c> (as opposed to a <c>Task</c> / <c>Task[T]</c>) —
    /// the async-function declaration binder needs this to select the
    /// matching state-machine builder / observable return type.
    /// </summary>
    /// <param name="type">The (declared) return type symbol to unwrap.</param>
    /// <param name="awaited">The unwrapped awaited result type, when this returns <c>true</c>.</param>
    /// <param name="isValueTask"><c>true</c> when the unwrapped shape was <c>ValueTask</c> / <c>ValueTask[T]</c>.</param>
    /// <returns><c>true</c> when <paramref name="type"/> is a Task / ValueTask shape.</returns>
    public static bool TryUnwrapTaskReturnType(TypeSymbol type, out TypeSymbol awaited, out bool isValueTask)
    {
        awaited = null;
        isValueTask = false;
        if (type == null)
        {
            return false;
        }

        // #313 symbolic construction: a Task[T] / ValueTask[T] over an in-scope
        // generic type parameter is type-erased in its ClrType, so recover the
        // symbolic result argument from the open definition + type arguments.
        if (type is ImportedTypeSymbol imported
            && imported.OpenDefinition != null
            && !imported.TypeArguments.IsDefaultOrEmpty
            && imported.TypeArguments.Length == 1)
        {
            var openName = imported.OpenDefinition.FullName;
            if (openName == "System.Threading.Tasks.Task`1"
                || openName == "System.Threading.Tasks.ValueTask`1")
            {
                awaited = imported.TypeArguments[0];
                isValueTask = openName == "System.Threading.Tasks.ValueTask`1";
                return true;
            }
        }

        var clr = type.ClrType;
        if (clr == null)
        {
            return false;
        }

        if (clr.IsSameAs(typeof(Task)) || clr.IsSameAs(typeof(ValueTask)))
        {
            awaited = TypeSymbol.Void;
            isValueTask = clr.IsSameAs(typeof(ValueTask));
            return true;
        }

        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var definition = clr.GetGenericTypeDefinition();
            if (definition.IsSameAs(typeof(Task<>)) || definition.IsSameAs(typeof(ValueTask<>)))
            {
                awaited = TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
                isValueTask = definition.IsSameAs(typeof(ValueTask<>));
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// CLR-type companion to <see cref="TryUnwrapTaskReturnType(TypeSymbol, out TypeSymbol)"/>: unwraps the
    /// awaited result of a <c>Task</c> / <c>Task&lt;T&gt;</c> / <c>ValueTask</c>
    /// / <c>ValueTask&lt;T&gt;</c> CLR return type (the non-generic forms resolve
    /// to <c>typeof(void)</c>). Used for matching an async method against an
    /// imported CLR interface method whose contract carries the explicit
    /// <c>Task</c> return type. Returns <c>false</c> for any other shape.
    /// </summary>
    /// <param name="type">The CLR return type to unwrap.</param>
    /// <param name="awaited">The unwrapped awaited CLR result type, when this returns <c>true</c>.</param>
    /// <returns><c>true</c> when <paramref name="type"/> is a Task / ValueTask shape.</returns>
    public static bool TryUnwrapTaskClrType(Type type, out Type awaited)
    {
        awaited = null;
        if (type == null)
        {
            return false;
        }

        if (type.IsSameAs(typeof(Task)) || type.IsSameAs(typeof(ValueTask)))
        {
            awaited = typeof(void);
            return true;
        }

        if (type.IsGenericType && !type.IsGenericTypeDefinition)
        {
            var definition = type.GetGenericTypeDefinition();
            if (definition.IsSameAs(typeof(Task<>)) || definition.IsSameAs(typeof(ValueTask<>)))
            {
                awaited = type.GetGenericArguments()[0];
                return true;
            }
        }

        return false;
    }
}
