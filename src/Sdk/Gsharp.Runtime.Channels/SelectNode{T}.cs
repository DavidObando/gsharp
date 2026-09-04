// <copyright file="SelectNode{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// One arm's registration in a selectable's waiter queue (ADR-0174 D8 step 4).
/// A counterpart that reaches this node CAS-claims the shared
/// <see cref="SelectWaiter"/> and transfers the value in the same step — for a
/// receive arm it deposits the value; for a rendezvous send arm the receiver
/// takes the value from here — so the winner never has to re-probe and can
/// never find the item gone. A claim for a stale generation fails, which is
/// what protects a pooled waiter from ABA.
/// </summary>
/// <typeparam name="T">The element type of the arm's selectable.</typeparam>
internal sealed class SelectNode<T> : WaiterNode<T>, IArmValue<T>, ISelectArm
{
    private readonly SelectWaiter waiter;
    private readonly long generation;
    private readonly int arm;
    private readonly ISelectableCore<T> selectable;
    private readonly bool isSend;
    private T? sendValue;
    private bool won;
    private T? received;

    /// <summary>Initializes a new instance of the <see cref="SelectNode{T}"/> class.</summary>
    /// <param name="waiter">The shared waiter.</param>
    /// <param name="generation">The waiter generation this registration belongs to.</param>
    /// <param name="arm">The arm index.</param>
    /// <param name="selectable">The selectable the node registers in.</param>
    /// <param name="isSend">Whether this is a send arm.</param>
    /// <param name="sendValue">The value a send arm offers.</param>
    internal SelectNode(SelectWaiter waiter, long generation, int arm, ISelectableCore<T> selectable, bool isSend, [AllowNull] T sendValue)
    {
        this.waiter = waiter;
        this.generation = generation;
        this.arm = arm;
        this.selectable = selectable;
        this.isSend = isSend;
        this.sendValue = sendValue;
    }

    /// <inheritdoc/>
    internal override bool IsNotify => false;

    /// <inheritdoc/>
    public void Deregister() => selectable.Deregister(this);

    /// <inheritdoc/>
    public T TakeArmValue()
    {
        var taken = received;
        received = default;
        return taken!;
    }

    /// <inheritdoc/>
    internal override bool TryCommitReceive(T value)
    {
        if (isSend || !waiter.TryClaim(generation, arm))
        {
            return false;
        }

        // Issue #3902 S4: the value stays typed on the node; the waiter only
        // records who holds it, so a value-typed element never boxes.
        received = value;
        waiter.DepositFrom(this, ok: true);
        won = true;
        return true;
    }

    /// <inheritdoc/>
    internal override bool TryCommitSend([MaybeNullWhen(false)] out T value)
    {
        if (!isSend || !waiter.TryClaim(generation, arm))
        {
            value = default;
            return false;
        }

        // Only reached once the arm has claimed the waiter, and a send arm is
        // constructed with its value, so the slot is populated here.
        value = sendValue!;
        sendValue = default;
        won = true;
        return true;
    }

    /// <inheritdoc/>
    internal override void OnClosed()
    {
        if (!waiter.TryClaim(generation, arm))
        {
            return;
        }

        won = true;
        if (isSend)
        {
            // Go: a select that sends on a closed channel panics.
            waiter.DepositFault(new ChannelClosedException("send on closed channel"));
        }
        else
        {
            // Go: a receive arm on a closed channel proceeds with the zero value.
            received = default;
            waiter.DepositFrom(this, ok: false);
        }
    }

    /// <inheritdoc/>
    internal override bool TryCancel(OperationCanceledException exception) => false;

    /// <inheritdoc/>
    internal override void Publish()
    {
        if (won)
        {
            won = false;
            waiter.PublishOutcome();
        }
    }
}
