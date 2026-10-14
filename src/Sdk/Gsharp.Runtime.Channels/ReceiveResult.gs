// <copyright file="ReceiveResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Diagnostics.CodeAnalysis

/// The result of a channel receive (ADR-0174 D3): the value and whether the
/// receive delivered one. `(value, true)` is a delivered value;
/// `(default, false)` is "closed and drained". A readonly struct so the
/// fast path stays allocation-free; the suspending receive returns it in its
/// result rather than through an `out` parameter because a receive that
/// parks produces its value after the method returned.
/// @typeparam T The channel element type.
struct ReceiveResult[T] {
    @AllowNull
    private let value T

    /// Initializes a new instance of the (cref:ReceiveResult{T}) struct.
    /// @param value The delivered value, or the element type's zero value when [`ok`](paramref) is false.
    /// @param ok Whether a value was delivered.
    init(@AllowNull value T, ok bool) {
        this.value = value
        Ok = ok
    }

    /// Gets the delivered value, or the element type's zero value when (cref:Ok) is false.
    @MaybeNull
    prop Value T -> value

    /// Gets a value indicating whether a value was delivered (false means closed and drained).
    prop Ok bool {
        get;
    }

    /// Gets the element as a plain `T` for the runtime's own forwarding into `T` slots
    /// (a (cref:System.Threading.Tasks.ValueTask{TResult}), a tuple, a buffer element).
    /// @remarks Issue #4681: forwarding the public (cref:Value) needed a `!`, which cs2gs carries into the
    /// migrated runtime as a fail-fast `!!` that throws on a `nil` element. The zero value of an
    /// unconstrained `T` is legitimately `null`, as in `List<T>`'s indexer, so this internal
    /// view drops the `MaybeNull` promise while the public property keeps it.
    internal prop Element T -> value

    /// Deconstructs into the Go-shaped `v, ok` pair.
    /// @param value The delivered value.
    /// @param ok Whether a value was delivered.
    func Deconstruct(@MaybeNull out value T, out ok bool) {
        value = this.value
        ok = Ok
    }

    shared {
        /// Gets the "closed and drained" result: the zero value with (cref:Ok) false.
        prop Closed ReceiveResult[T] -> ReceiveResult[T](default(T), false)

        /// Returns the zero value of `T` as a plain `T`, with no null-forgiving operator (a bare `default`
        /// would warn for an unconstrained `T`).
        /// @returns The zero value, which is `null` for a reference type.
        internal func ZeroValue() T -> default(ReceiveResult[T]).Element
    }
}
