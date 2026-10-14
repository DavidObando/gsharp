// <copyright file="WaiterNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Diagnostics.CodeAnalysis

/// A parked party in a channel's receiver or sender queue (ADR-0174 D1/D8).
/// Nodes are intrusive doubly-linked so loser deregistration is O(1). A
/// counterpart arriving at the channel pops the head node under the channel
/// lock and asks it to commit the transfer; the node's continuation is fired
/// by (cref:WaiterNodeBase.Publish) only after the lock has been released.
/// @typeparam T The channel element type.
internal abstract class WaiterNode[T] : WaiterNodeBase {
    /// Gets or sets the previous node in the owning queue.
    internal prop Prev WaiterNode[T]?

    /// Gets or sets the next node in the owning queue.
    internal prop Next WaiterNode[T]?

    /// Gets or sets the queue this node is linked into, or null when unlinked.
    internal prop Queue WaiterQueue[T]?

    /// Gets a value indicating whether the node is currently linked into a queue.
    internal prop IsLinked bool -> Queue != nil

    /// Gets a value indicating whether this is a notification-only node
    /// (`WaitToReadAsync`/`WaitToWriteAsync`): it is told that a
    /// transfer became possible but never consumes one.
    internal abstract prop IsNotify bool {
        get;
    }

    /// Called under the channel lock by an arriving sender (or by a value
    /// leaving the buffer) for a node parked as a receiver. Returns true when
    /// this node took the value.
    /// @param value The value on offer.
    /// @returns True when the transfer committed to this node.
    internal open func TryCommitReceive(value T) bool;

    /// Called under the channel lock by an arriving receiver (or by room
    /// appearing in the buffer) for a node parked as a sender. Returns true
    /// when this node handed over its value.
    /// @param value The value handed over.
    /// @returns True when the transfer committed from this node.
    internal open func TryCommitSend(@MaybeNullWhen(false) out value T) bool;

    /// Called under the channel lock when the channel is closed while this node is parked.
    internal open func OnClosed();

    /// Attempts to fail this node with a cancellation; false when the transfer already committed (ADR-0174
    /// D7 linearization rule).
    /// @param exception The cancellation to surface.
    /// @returns True when the node transitioned to cancelled.
    internal open func TryCancel(exception OperationCanceledException) bool;
}

/// An intrusive FIFO of (cref:WaiterNode{T}). Not thread-safe; every
/// operation runs under the owning channel's lock.
/// @typeparam T The channel element type.
internal class WaiterQueue[T] {
    private var head WaiterNode[T]?
    private var tail WaiterNode[T]?

    /// Gets the number of linked nodes.
    internal prop Count int32 {
        get;
        private set;
    }

    /// Gets the number of linked nodes that would consume a transfer (non-notify nodes).
    internal prop DataCount int32 {
        get;
        private set;
    }

    /// Appends a node.
    /// @param node The node to link.
    internal func Enqueue(node WaiterNode[T]) {
        node.Queue = this
        node.Prev = tail
        node.Next = nil
        if tail == nil {
            head = node
        } else {
            this.tail!!.Next = node
        }
        tail = node
        Count++
        if !node.IsNotify {
            DataCount++
        }
    }

    /// Removes and returns the head node.
    /// @param node The dequeued node.
    /// @returns True when a node was dequeued.
    internal func TryDequeue(@NotNullWhen(true) out node WaiterNode[T]?) bool {
        if head == nil {
            node = nil
            return false
        }
        node = head
        Remove(node!!)
        return true
    }

    /// Unlinks a node. No-op when the node is not linked into this queue.
    /// @param node The node to unlink.
    internal func Remove(node WaiterNode[T]) {
        if node.Queue != this {
            return
        }
        if node.Prev == nil {
            head = node.Next
        } else {
            node.Prev!!.Next = node.Next
        }
        if node.Next == nil {
            tail = node.Prev
        } else {
            node.Next!!.Prev = node.Prev
        }
        node.Prev = nil
        node.Next = nil
        node.Queue = nil
        Count--
        if !node.IsNotify {
            DataCount--
        }
    }
}
