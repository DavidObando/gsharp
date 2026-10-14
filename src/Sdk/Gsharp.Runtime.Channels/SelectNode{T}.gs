// <copyright file="SelectNode{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Diagnostics.CodeAnalysis
import System.Threading.Channels

/// One arm's registration in a selectable's waiter queue (ADR-0174 D8 step 4).
/// A counterpart that reaches this node CAS-claims the shared
/// (cref:SelectWaiter) and transfers the value in the same step — for a
/// receive arm it deposits the value; for a rendezvous send arm the receiver
/// takes the value from here — so the winner never has to re-probe and can
/// never find the item gone. A claim for a stale generation fails, which is
/// what protects a pooled waiter from ABA.
/// @typeparam T The element type of the arm's selectable.
internal class SelectNode[T] : WaiterNode[T], IArmValue[T], ISelectArm {
    private let waiter SelectWaiter
    private let generation int64
    private let arm int32
    private let selectable ISelectableCore[T]
    private let isSend bool

    @AllowNull
    private var sendValue T

    private var won bool

    @AllowNull
    private var received T

    /// Initializes a new instance of the (cref:SelectNode{T}) class.
    /// @param waiter The shared waiter.
    /// @param generation The waiter generation this registration belongs to.
    /// @param arm The arm index.
    /// @param selectable The selectable the node registers in.
    /// @param isSend Whether this is a send arm.
    /// @param sendValue The value a send arm offers.
    internal init(
        waiter SelectWaiter,
        generation int64,
        arm int32,
        selectable ISelectableCore[T],
        isSend bool,
        @AllowNull sendValue T
    ) {
        this.waiter = waiter
        this.generation = generation
        this.arm = arm
        this.selectable = selectable
        this.isSend = isSend
        this.sendValue = sendValue
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop IsNotify bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Deregister() -> selectable.Deregister(this)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func TakeArmValue() T {
        let taken = received
        received = default(T)
        // Only the winning arm takes the value, and the winner deposited it
        // first; a closed arm deposits the zero value on purpose (D3).
        return taken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCommitReceive(value T) bool {
        if isSend || !waiter.TryClaim(generation, arm) {
            return false
        }
        // Issue #3902 S4: the value stays typed on the node; the waiter only
        // records who holds it, so a value-typed element never boxes.
        received = value
        waiter.DepositFrom(this, ok: true)
        won = true
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCommitSend(@MaybeNullWhen(false) out value T) bool {
        if !isSend || !waiter.TryClaim(generation, arm) {
            value = default(T)
            return false
        }
        // Only reached once the arm has claimed the waiter, and a send arm is
        // constructed with its value, so the slot is populated here.
        value = sendValue
        sendValue = default(T)
        won = true
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func OnClosed() {
        if !waiter.TryClaim(generation, arm) {
            return
        }
        won = true
        if isSend {
            // Go: a select that sends on a closed channel panics.
            waiter.DepositFault(ChannelClosedException("send on closed channel"))
        } else {
            // Go: a receive arm on a closed channel proceeds with the zero value.
            received = default(T)
            waiter.DepositFrom(this, ok: false)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCancel(exception OperationCanceledException) bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Publish() {
        if won {
            won = false
            waiter.PublishOutcome()
        }
    }
}
