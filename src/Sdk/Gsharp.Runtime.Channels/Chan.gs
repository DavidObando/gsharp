// <copyright file="Chan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

/// Static factories for the G#-owned channel type (ADR-0174 D1/D12). The
/// generic (cref:Chan{T}) is constructed from G# by the type clause
/// applied to arguments, `chan[T]()` / `chan[T](n)`; this
/// non-generic host carries the one factory that has no such spelling.
shared class Chan {
    /// Creates an unbounded channel — the wave-1 behavior of `make(chan T)`,
    /// now named. Deliberately the wordiest construction form: an unbounded
    /// buffer is a memory-leak risk Go does not even offer, and code that
    /// genuinely wants it should have to say so.
    /// @typeparam T The element type.
    /// @returns A new unbounded channel.
    func Unbounded[T]() Chan[T] -> Chan[T].CreateUnbounded()
}
