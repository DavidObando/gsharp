// <copyright file="ISelectable.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Diagnostics.CodeAnalysis

/// Something a G# `select` receive arm can probe (ADR-0174 D1/D8):
/// channels constructed by G#, and the timer selectables `after` and
/// `tick`. The three-state encoding is normative: `(true, true)` a
/// value; `(true, false)` closed and drained, `value` is
/// the zero value; `(false, _)` nothing available right now.
/// @typeparam T The element type.
interface ISelectable[T] {
    /// Attempts a non-blocking receive.
    /// @param value The delivered value, or the zero value.
    /// @param ok Whether a value was delivered; false with a true return means closed and drained.
    /// @returns True when the receive completed (with a value or with closed), false when it would have to
    /// park.
    func TryReceive(@MaybeNull out value T, out ok bool) bool;
}
