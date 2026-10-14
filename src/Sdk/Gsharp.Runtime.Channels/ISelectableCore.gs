// <copyright file="ISelectableCore.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Diagnostics.CodeAnalysis

/// The registration protocol a `select` arm needs beyond (cref:ISelectable{T})
/// (ADR-0174 D8). Internal: only runtime-owned selectables — (cref:Chan{T}),
/// (cref:AfterTimer), (cref:TickTimer) — can participate in the
/// transactional slow path; a foreign channel takes the documented re-probe fallback.
/// @typeparam T The element type.
internal interface ISelectableCore[T] : ISelectable[T] {
    /// Gets the total-order key used to acquire several gates without deadlock.
    prop SelectOrder int64 {
        get;
    }

    /// Gets the lock the select holds while probing and registering, or null when the selectable locks
    /// privately (timers).
    prop SelectGate object? {
        get;
    }

    /// Probes with (cref:SelectGate) held; commits atomically or fails.
    /// @param value The delivered value, or the zero value.
    /// @param ok Whether a value was delivered.
    /// @param completions Nodes claimed as a side effect, to publish after the locks are released.
    /// @returns True when the receive completed.
    func TryReceiveLocked(@MaybeNull out value T, out ok bool, ref completions Completions) bool;

    /// Registers a receive arm with (cref:SelectGate) held (channels) or under a private lock (timers,
    /// which may claim synchronously).
    /// @param node The arm's node.
    func RegisterReceiveLocked(node SelectNode[T]);

    /// Removes a losing arm's registration. Takes its own lock; O(1); idempotent.
    /// @param node The arm's node.
    func Deregister(node SelectNode[T]);
}

/// A selectable that also accepts send arms.
/// @typeparam T The element type.
internal interface ISendSelectableCore[T] : ISelectableCore[T] {
    /// Probes a send with (cref:ISelectableCore{T}.SelectGate) held.
    /// @param value The value to send.
    /// @param completions Nodes claimed as a side effect.
    /// @returns True when the send committed.
    func TrySendLocked(value T, ref completions Completions) bool;

    /// Registers a send arm with the gate held.
    /// @param node The arm's node, carrying the value.
    func RegisterSendLocked(node SelectNode[T]);
}
