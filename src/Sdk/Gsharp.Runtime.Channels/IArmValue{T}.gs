// <copyright file="IArmValue{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

/// A select participant that holds the winning value in its own typed field
/// (issue #3902 S4).
/// @remarks (cref:SelectWaiter) is not generic, so it used to take the winning
/// value as `object?` — which boxed every value-typed element on both the
/// ready and the parked path. The value now stays with whichever participant
/// produced it (the arm descriptor when the probe succeeded, the parked node
/// when the transfer did), and `TakeValue<T>` reaches it through
/// this interface: a cast, not a box.
/// @typeparam T The element type.
internal interface IArmValue[out T] {
    /// Takes the deposited value, clearing it. Called once, by the winner.
    /// @returns The value.
    func TakeArmValue() T;
}
