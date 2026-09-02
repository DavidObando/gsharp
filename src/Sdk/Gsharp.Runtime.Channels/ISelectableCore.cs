// <copyright file="ISelectableCore.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The registration protocol a <c>select</c> arm needs beyond <see cref="ISelectable{T}"/>
/// (ADR-0174 D8). Internal: only runtime-owned selectables — <see cref="Chan{T}"/>,
/// <see cref="AfterTimer"/>, <see cref="TickTimer"/> — can participate in the
/// transactional slow path; a foreign channel takes the documented re-probe fallback.
/// </summary>
/// <typeparam name="T">The element type.</typeparam>
internal interface ISelectableCore<T> : ISelectable<T>
{
    /// <summary>Gets the total-order key used to acquire several gates without deadlock.</summary>
    long SelectOrder { get; }

    /// <summary>Gets the lock the select holds while probing and registering, or null when the selectable locks privately (timers).</summary>
    object? SelectGate { get; }

    /// <summary>Probes with <see cref="SelectGate"/> held; commits atomically or fails.</summary>
    /// <param name="value">The delivered value, or the zero value.</param>
    /// <param name="ok">Whether a value was delivered.</param>
    /// <param name="completions">Nodes claimed as a side effect, to publish after the locks are released.</param>
    /// <returns>True when the receive completed.</returns>
    bool TryReceiveLocked(out T value, out bool ok, ref Completions completions);

    /// <summary>Registers a receive arm with <see cref="SelectGate"/> held (channels) or under a private lock (timers, which may claim synchronously).</summary>
    /// <param name="node">The arm's node.</param>
    void RegisterReceiveLocked(SelectNode<T> node);

    /// <summary>Removes a losing arm's registration. Takes its own lock; O(1); idempotent.</summary>
    /// <param name="node">The arm's node.</param>
    void Deregister(SelectNode<T> node);
}

/// <summary>A selectable that also accepts send arms.</summary>
/// <typeparam name="T">The element type.</typeparam>
internal interface ISendSelectableCore<T> : ISelectableCore<T>
{
    /// <summary>Probes a send with <see cref="ISelectableCore{T}.SelectGate"/> held.</summary>
    /// <param name="value">The value to send.</param>
    /// <param name="completions">Nodes claimed as a side effect.</param>
    /// <returns>True when the send committed.</returns>
    bool TrySendLocked(T value, ref Completions completions);

    /// <summary>Registers a send arm with the gate held.</summary>
    /// <param name="node">The arm's node, carrying the value.</param>
    void RegisterSendLocked(SelectNode<T> node);
}
