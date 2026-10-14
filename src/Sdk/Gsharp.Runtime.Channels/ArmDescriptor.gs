// <copyright file="ArmDescriptor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Diagnostics.CodeAnalysis
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// One arm of a `select` as recorded by (cref:SelectWaiter.AddReceive{T}(Channel{T}, int))
/// and friends: how to probe it under the gates, how to register it, and how
/// to tear the registration down when it loses.
internal abstract class ArmDescriptor : IDisposable {
    /// Initializes a new instance of the (cref:ArmDescriptor) class.
    /// @param arm The arm index.
    protected init(arm int32) {
        Arm = arm
    }

    /// Gets the arm index; reset when a cached descriptor is retargeted (issue #3902 S4).
    internal prop Arm int32 {
        get;
        internal set;
    }

    /// Gets a value indicating whether the arm probes and registers under a shared gate (G# channels)
    /// rather than privately (timers) or lock-free (foreign channels, tasks).
    internal abstract prop RequiresGate bool {
        get;
    }

    /// Gets the gate, or null.
    internal abstract prop Gate object? {
        get;
    }

    /// Gets the gate's total-order key.
    internal abstract prop Order int64 {
        get;
    }

    /// Removes the registration; same as (cref:Deregister).
    func Dispose() -> Deregister()

    /// Probes with the gate held; on success the outcome has been deposited (a fault counts as success).
    /// @param waiter The waiter to deposit into.
    /// @param completions Nodes claimed as a side effect.
    /// @returns True when the arm completed.
    internal open func TryProbe(waiter SelectWaiter, ref completions Completions) bool;

    /// Registers the arm (with the gate held when (cref:RequiresGate)).
    /// @param waiter The shared waiter.
    /// @param generation The waiter generation.
    internal open func Register(waiter SelectWaiter, generation int64);

    /// Removes the registration. Idempotent; takes whatever lock it needs.
    internal open func Deregister();

    /// Drops references to the select's participants so a thread-cached waiter
    /// does not pin them (issue #3902 S4). Called after (cref:Deregister)
    /// when the select completes; the descriptor object itself is kept for the
    /// next select in that slot.
    internal open func Release() { }
}

/// A receive arm over a runtime-owned selectable (a (cref:Chan{T}) or a timer).
/// @typeparam T The element type.
internal class CoreReceiveArm[T] : ArmDescriptor, IArmValue[T] {
    private var selectable ISelectableCore[T]?
    private var node SelectNode[T]?

    @AllowNull
    private var pending T

    /// Initializes a new instance of the (cref:CoreReceiveArm{T}) class.
    /// @param selectable The selectable.
    /// @param arm The arm index.
    internal init(selectable ISelectableCore[T], arm int32) : base(arm) {
        this.selectable = selectable
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop RequiresGate bool -> Selectable.SelectGate != nil

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop Gate object? -> Selectable.SelectGate

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop Order int64 -> Selectable.SelectOrder

    // Read only between Retarget and Release, both driven by the waiter; a null
    // here would mean the waiter walked a slot it had already released.
    private prop Selectable ISelectableCore[T] -> selectable!!

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func TakeArmValue() T {
        let taken = pending
        pending = default(T)
        return taken
    }

    /// Points a cached descriptor at a new select's participants (issue #3902 S4).
    /// @param target The selectable.
    /// @param arm The arm index.
    internal func Retarget(target ISelectableCore[T], arm int32) {
        selectable = target
        Arm = arm
        node = nil
        pending = default(T)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Release() {
        selectable = nil
        node = nil
        pending = default(T)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryProbe(waiter SelectWaiter, ref completions Completions) bool {
        if !Selectable.TryReceiveLocked(out var value, out var ok, &completions) {
            return false
        }
        // The value stays here, typed (issue #3902 S4): the waiter records who
        // holds it rather than taking it as object and boxing.
        pending = value
        waiter.DepositFrom(this, ok)
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Register(waiter SelectWaiter, generation int64) {
        node = SelectNode[T](waiter, generation, Arm, Selectable, isSend: false, default(T))
        Selectable.RegisterReceiveLocked(node!!)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Deregister() {
        if node is {} registered {
            node = nil
            Selectable.Deregister(registered)
        }
    }
}

/// A send arm over a (cref:Chan{T}).
/// @typeparam T The element type.
internal class CoreSendArm[T] : ArmDescriptor {
    private var selectable ISendSelectableCore[T]?

    @AllowNull
    private var value T

    private var node SelectNode[T]?

    /// Initializes a new instance of the (cref:CoreSendArm{T}) class.
    /// @param selectable The selectable.
    /// @param value The value the arm offers.
    /// @param arm The arm index.
    internal init(selectable ISendSelectableCore[T], value T, arm int32) : base(arm) {
        this.selectable = selectable
        this.value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop RequiresGate bool -> true

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop Gate object? -> Selectable.SelectGate

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop Order int64 -> Selectable.SelectOrder

    // See CoreReceiveArm.
    private prop Selectable ISendSelectableCore[T] -> selectable!!

    /// Points a cached descriptor at a new select's participants (issue #3902 S4).
    /// @param target The selectable.
    /// @param offered The value the arm offers.
    /// @param arm The arm index.
    internal func Retarget(target ISendSelectableCore[T], offered T, arm int32) {
        selectable = target
        value = offered
        Arm = arm
        node = nil
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Release() {
        selectable = nil
        value = default(T)
        node = nil
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryProbe(waiter SelectWaiter, ref completions Completions) bool {
        try {
            // Set by the constructor or by Retarget, both of which run before
            // the waiter can probe this arm; Release only runs after it is done.
            return Selectable.TrySendLocked(value, &completions)
        } catch (closed ChannelClosedException) {
            // Go: a select that sends on a closed channel panics.
            waiter.DepositFault(closed)
            return true
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Register(waiter SelectWaiter, generation int64) {
        // As in TryProbe: live between Retarget and Release.
        node = SelectNode[T](waiter, generation, Arm, Selectable, isSend: true, value)
        Selectable.RegisterSendLocked(node!!)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Deregister() {
        if node is {} registered {
            node = nil
            Selectable.Deregister(registered)
        }
    }
}

/// A receive arm over a foreign (cref:ChannelReader{T}). A public
/// reader exposes no reservation primitive, so the arm can only report
/// readiness: the select re-probes and may find the item taken (ADR-0174 D8).
/// @typeparam T The element type.
internal class ForeignReceiveArm[T] : ArmDescriptor {
    private let reader ChannelReader[T]
    private var cancellation CancellationTokenSource?

    /// Initializes a new instance of the (cref:ForeignReceiveArm{T}) class.
    /// @param reader The foreign reader.
    /// @param arm The arm index.
    internal init(reader ChannelReader[T], arm int32) : base(arm) {
        this.reader = reader
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop RequiresGate bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop Gate object? -> nil

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop Order int64 -> 0

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryProbe(waiter SelectWaiter, ref completions Completions) bool {
        if reader.TryRead(out var item) {
            waiter.Deposit(item, ok: true, needsReprobe: false)
            return true
        }
        if reader.Completion.IsCompleted {
            waiter.Deposit(default(T), ok: false, needsReprobe: false)
            return true
        }
        return false
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Register(waiter SelectWaiter, generation int64) {
        var completions = default(Completions)
        if TryProbe(waiter, &completions) {
            if waiter.TryClaim(generation, Arm) {
                waiter.PublishOutcome()
            }
            return
        }
        cancellation = CancellationTokenSource()
        let readiness = reader.WaitToReadAsync(cancellation!!.Token)
        let arm = Arm
        readiness
            .ConfigureAwait(false)
            .GetAwaiter()
            .UnsafeOnCompleted(
            () -> {
                if !waiter.TryClaim(generation, arm) {
                    return
                }
                try {
                    if readiness.Result {
                        waiter.Deposit(nil, ok: true, needsReprobe: true)
                    } else {
                        waiter.Deposit(default(T), ok: false, needsReprobe: false)
                    }
                } catch (exception Exception) {
                    waiter.DepositFault(exception)
                }
                waiter.PublishOutcome()
            }
        )
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Deregister() {
        if cancellation is {} pending {
            cancellation = nil
            pending.Cancel()
            pending.Dispose()
        }
    }
}

/// A send arm over a foreign (cref:ChannelWriter{T}); readiness only, like (cref:ForeignReceiveArm{T}).
/// @typeparam T The element type.
internal class ForeignSendArm[T] : ArmDescriptor {
    private let writer ChannelWriter[T]
    private let value T
    private var cancellation CancellationTokenSource?

    /// Initializes a new instance of the (cref:ForeignSendArm{T}) class.
    /// @param writer The foreign writer.
    /// @param value The value the arm offers.
    /// @param arm The arm index.
    internal init(writer ChannelWriter[T], value T, arm int32) : base(arm) {
        this.writer = writer
        this.value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop RequiresGate bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop Gate object? -> nil

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop Order int64 -> 0

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryProbe(waiter SelectWaiter, ref completions Completions) bool {
        if writer.TryWrite(value) {
            waiter.Deposit(nil, ok: true, needsReprobe: false)
            return true
        }
        return false
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Register(waiter SelectWaiter, generation int64) {
        var completions = default(Completions)
        if TryProbe(waiter, &completions) {
            if waiter.TryClaim(generation, Arm) {
                waiter.PublishOutcome()
            }
            return
        }
        cancellation = CancellationTokenSource()
        let readiness = writer.WaitToWriteAsync(cancellation!!.Token)
        let arm = Arm
        readiness
            .ConfigureAwait(false)
            .GetAwaiter()
            .UnsafeOnCompleted(
            () -> {
                if !waiter.TryClaim(generation, arm) {
                    return
                }
                try {
                    if readiness.Result {
                        waiter.Deposit(nil, ok: true, needsReprobe: true)
                    } else {
                        waiter.DepositFault(ChannelClosedException("send on closed channel"))
                    }
                } catch (exception Exception) {
                    waiter.DepositFault(exception)
                }
                waiter.PublishOutcome()
            }
        )
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Deregister() {
        if cancellation is {} pending {
            cancellation = nil
            pending.Cancel()
            pending.Dispose()
        }
    }
}

/// A `case await task` arm.
internal open class TaskArm : ArmDescriptor {
    private let task Task
    private var cancellation CancellationTokenSource?

    /// Initializes a new instance of the (cref:TaskArm) class.
    /// @param task The task.
    /// @param arm The arm index.
    internal init(task Task, arm int32) : base(arm) {
        this.task = task
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal open override prop RequiresGate bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal open override prop Gate object? -> nil

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal open override prop Order int64 -> 0

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal open override func TryProbe(waiter SelectWaiter, ref completions Completions) bool {
        if !task.IsCompleted {
            return false
        }
        DepositCompleted(waiter, task)
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal open override func Register(waiter SelectWaiter, generation int64) {
        var completions = default(Completions)
        if TryProbe(waiter, &completions) {
            if waiter.TryClaim(generation, Arm) {
                waiter.PublishOutcome()
            }
            return
        }
        cancellation = CancellationTokenSource()
        let arm = Arm
        task.ContinueWith(
            (completed Task, state object?) -> {
                // The state is the tuple this method passed to ContinueWith.
                let (self, w) = cast[(TaskArm, SelectWaiter)](state!!)
                if !w.TryClaim(generation, arm) {
                    return
                }
                self.DepositCompleted(w, completed)
                w.PublishOutcome()
            },
            (this, waiter),
            cancellation!!.Token,
            TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.DenyChildAttach,
            TaskScheduler.Default
        )
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal open override func Deregister() {
        // Removing the continuation is what keeps a long-running losing task
        // from retaining the waiter.
        if cancellation is {} pending {
            cancellation = nil
            pending.Cancel()
            pending.Dispose()
        }
    }

    /// Deposits a completed task's outcome.
    /// @param waiter The waiter.
    /// @param completed The completed task.
    protected open func DepositCompleted(waiter SelectWaiter, completed Task) {
        if completed.IsCompletedSuccessfully {
            waiter.Deposit(nil, ok: true, needsReprobe: false)
        } else {
            waiter.DepositFault(Unwrap(completed))
        }
    }

    shared {
        /// Extracts the exception a faulted or cancelled task carries.
        /// @param completed The task.
        /// @returns The exception to surface.
        protected func Unwrap(completed Task) Exception -> cast[Exception?](completed.Exception?.InnerException) ??
            cast[Exception?](completed.Exception) ??
            TaskCanceledException(completed)
    }
}

/// A `case let v = await task` arm.
/// @typeparam T The task result type.
internal class TaskArm[T] : Gsharp.Concurrency.TaskArm {
    /// Initializes a new instance of the (cref:TaskArm{T}) class.
    /// @param task The task.
    /// @param arm The arm index.
    internal init(task Task[T], arm int32) : base(task, arm) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func DepositCompleted(waiter SelectWaiter, completed Task) {
        if completed.IsCompletedSuccessfully {
            waiter.Deposit((cast[Task[T]](completed)).Result, ok: true, needsReprobe: false)
        } else {
            waiter.DepositFault(TaskArm.Unwrap(completed))
        }
    }
}
