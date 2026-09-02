// <copyright file="WaiterNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// A parked party in a channel's receiver or sender queue (ADR-0174 D1/D8).
/// Nodes are intrusive doubly-linked so loser deregistration is O(1). A
/// counterpart arriving at the channel pops the head node under the channel
/// lock and asks it to commit the transfer; the node's continuation is fired
/// by <see cref="WaiterNodeBase.Publish"/> only after the lock has been released.
/// </summary>
/// <typeparam name="T">The channel element type.</typeparam>
internal abstract class WaiterNode<T> : WaiterNodeBase
{
    /// <summary>Gets or sets the previous node in the owning queue.</summary>
    internal WaiterNode<T>? Prev { get; set; }

    /// <summary>Gets or sets the next node in the owning queue.</summary>
    internal WaiterNode<T>? Next { get; set; }

    /// <summary>Gets or sets the queue this node is linked into, or null when unlinked.</summary>
    internal WaiterQueue<T>? Queue { get; set; }

    /// <summary>Gets a value indicating whether the node is currently linked into a queue.</summary>
    internal bool IsLinked => Queue is not null;

    /// <summary>
    /// Gets a value indicating whether this is a notification-only node
    /// (<c>WaitToReadAsync</c>/<c>WaitToWriteAsync</c>): it is told that a
    /// transfer became possible but never consumes one.
    /// </summary>
    internal abstract bool IsNotify { get; }

    /// <summary>
    /// Called under the channel lock by an arriving sender (or by a value
    /// leaving the buffer) for a node parked as a receiver. Returns true when
    /// this node took the value.
    /// </summary>
    /// <param name="value">The value on offer.</param>
    /// <returns>True when the transfer committed to this node.</returns>
    internal abstract bool TryCommitReceive(T value);

    /// <summary>
    /// Called under the channel lock by an arriving receiver (or by room
    /// appearing in the buffer) for a node parked as a sender. Returns true
    /// when this node handed over its value.
    /// </summary>
    /// <param name="value">The value handed over.</param>
    /// <returns>True when the transfer committed from this node.</returns>
    internal abstract bool TryCommitSend(out T value);

    /// <summary>Called under the channel lock when the channel is closed while this node is parked.</summary>
    internal abstract void OnClosed();

    /// <summary>Attempts to fail this node with a cancellation; false when the transfer already committed (ADR-0174 D7 linearization rule).</summary>
    /// <param name="exception">The cancellation to surface.</param>
    /// <returns>True when the node transitioned to cancelled.</returns>
    internal abstract bool TryCancel(OperationCanceledException exception);
}

/// <summary>
/// An intrusive FIFO of <see cref="WaiterNode{T}"/>. Not thread-safe; every
/// operation runs under the owning channel's lock.
/// </summary>
/// <typeparam name="T">The channel element type.</typeparam>
internal sealed class WaiterQueue<T>
{
    private WaiterNode<T>? head;
    private WaiterNode<T>? tail;

    /// <summary>Gets the number of linked nodes.</summary>
    internal int Count { get; private set; }

    /// <summary>Gets the number of linked nodes that would consume a transfer (non-notify nodes).</summary>
    internal int DataCount { get; private set; }

    /// <summary>Appends a node.</summary>
    /// <param name="node">The node to link.</param>
    internal void Enqueue(WaiterNode<T> node)
    {
        node.Queue = this;
        node.Prev = tail;
        node.Next = null;
        if (tail is null)
        {
            head = node;
        }
        else
        {
            tail.Next = node;
        }

        tail = node;
        Count++;
        if (!node.IsNotify)
        {
            DataCount++;
        }
    }

    /// <summary>Removes and returns the head node.</summary>
    /// <param name="node">The dequeued node.</param>
    /// <returns>True when a node was dequeued.</returns>
    internal bool TryDequeue(out WaiterNode<T> node)
    {
        if (head is null)
        {
            node = null!;
            return false;
        }

        node = head;
        Remove(node);
        return true;
    }

    /// <summary>Unlinks a node. No-op when the node is not linked into this queue.</summary>
    /// <param name="node">The node to unlink.</param>
    internal void Remove(WaiterNode<T> node)
    {
        if (node.Queue != this)
        {
            return;
        }

        if (node.Prev is null)
        {
            head = node.Next;
        }
        else
        {
            node.Prev.Next = node.Next;
        }

        if (node.Next is null)
        {
            tail = node.Prev;
        }
        else
        {
            node.Next.Prev = node.Prev;
        }

        node.Prev = null;
        node.Next = null;
        node.Queue = null;
        Count--;
        if (!node.IsNotify)
        {
            DataCount--;
        }
    }
}
