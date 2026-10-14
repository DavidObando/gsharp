// <copyright file="SelectWaiter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Collections.Generic
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import System.Threading.Tasks.Sources

/// The single registered waiter behind a parked G# `select` (ADR-0174 D8).
/// One instance is registered in the waiter queue of every arm's channel; the
/// first counterpart to reach it CAS-claims a <em>generation-stamped</em>
/// winner slot and transfers the value in the same step, so winning
/// <em>is</em> the transfer. Losers are deregistered by (cref:Return)
/// before the arm body runs. Registration acquires every distinct channel
/// gate in ascending (cref:Chan{T}.Id) order (a total order, so
/// selects over overlapping channel sets cannot deadlock) and re-probes every
/// arm under the locks before parking, which closes the readiness/commit gap
/// for G# channels. Foreign BCL channels, (cref:Task)s, timers and the
/// ambient cancellation claim the same slot from their own callbacks; a
/// foreign arm reports (cref:NeedsReprobe) because readiness on a
/// public `ChannelReader` does not reserve an item.
/// @remarks The emitted protocol is: `Rent`, `Add*` per arm, `await WaitAsync()`
/// (winning arm index; throws the ambient cancellation or a send-on-closed),
/// `NeedsReprobe` → `Return` and loop, else `TakeValue`/`Ok`
/// for a receive arm, then `Return`. Waiters are pooled per thread; a
/// stale claim against a reused waiter is defeated by the generation check.
class SelectWaiter : IValueTaskSource[int32] {
    private let arms List[ArmDescriptor] = List[ArmDescriptor]()
    private let gates List[(Order int64, Gate object)] = List[(Order int64, Gate object)]()
    private var core ManualResetValueTaskSourceCore[int32]
    private var word int64 = StateIdle
    private var winnerArm int32 = -1
    private var armCount int32
    private var valueOwner object?
    private var value object?
    private var ok bool
    private var needsReprobe bool
    private var fault Exception?
    private var token CancellationToken
    private var tokenRegistration CancellationTokenRegistration
    private var hasTokenRegistration bool
    private var cancelledArm int32 = -1
    private var canPool bool = true

    private init() {
        this.core.RunContinuationsAsynchronously = true
    }

    /// Gets a value indicating whether the winning arm was a foreign channel whose readiness must be
    /// re-probed (the transfer did not happen yet).
    prop NeedsReprobe bool -> needsReprobe

    /// Gets a value indicating whether the winning receive arm delivered a value (false: its channel is
    /// closed).
    prop Ok bool -> ok

    /// Gets the current generation; a claim must carry it to succeed.
    internal prop Generation int64 -> Volatile.Read(&word) >> StateBits

    /// Gets the number of registered arms. Diagnostic.
    internal prop ArmCount int32 -> armCount

    /// Adds a receive arm over a G# channel. The most specific overload: a (cref:Chan{T}) is both a
    /// (cref:Channel{T}) and an (cref:ISelectable{T}).
    /// @typeparam T The element type.
    /// @param channel The channel; `nil` disables the arm.
    /// @param arm The arm index.
    func AddReceive[T](channel Chan[T]?, arm int32) {
        if channel != nil {
            PlaceReceive(channel, arm)
        }
    }

    /// Adds a receive arm over a channel (fast path when it is a (cref:Chan{T}), re-probe fallback
    /// otherwise).
    /// @typeparam T The element type.
    /// @param channel The channel; `nil` disables the arm.
    /// @param arm The arm index.
    func AddReceive[T](channel Channel[T]?, arm int32) {
        switch channel {
            case chan_ is Chan[T] {
                PlaceReceive(chan_, arm)
            }
            case nil { }
            default {
                Place(ForeignReceiveArm[T](channel!!.Reader, arm))
            }
        }
    }

    /// Adds a receive arm over a receive-only handle.
    /// @typeparam T The element type.
    /// @param reader The reader; `nil` disables the arm.
    /// @param arm The arm index.
    func AddReceive[T](reader ChannelReader[T]?, arm int32) {
        switch reader {
            case owned is Chan[T].ChanReader {
                PlaceReceive(owned.Owner, arm)
            }
            case nil { }
            default {
                Place(ForeignReceiveArm[T](reader!!, arm))
            }
        }
    }

    /// Adds a receive arm over a runtime selectable such as `after(d)` or `tick(d)`.
    /// @typeparam T The element type.
    /// @param selectable The selectable; `nil` disables the arm.
    /// @param arm The arm index.
    func AddReceive[T](selectable ISelectable[T]?, arm int32) {
        switch selectable {
            case core is ISelectableCore[T] {
                PlaceReceive(core, arm)
            }
            case nil { }
            default {
                throw NotSupportedException(
                    "'${selectable!!.GetType()}' cannot participate in select: only runtime-owned selectables register a waiter."
                )
            }
        }
    }

    /// Adds a send arm over a G# channel (the most specific overload).
    /// @typeparam T The element type.
    /// @param channel The channel; `nil` disables the arm.
    /// @param value The value the arm offers.
    /// @param arm The arm index.
    func AddSend[T](channel Chan[T]?, value T, arm int32) {
        if channel != nil {
            PlaceSend(channel, value, arm)
        }
    }

    /// Adds a send arm over a channel.
    /// @typeparam T The element type.
    /// @param channel The channel; `nil` disables the arm.
    /// @param value The value the arm offers.
    /// @param arm The arm index.
    func AddSend[T](channel Channel[T]?, value T, arm int32) {
        switch channel {
            case chan_ is Chan[T] {
                PlaceSend(chan_, value, arm)
            }
            case nil { }
            default {
                Place(ForeignSendArm[T](channel!!.Writer, value, arm))
            }
        }
    }

    /// Adds a send arm over a send-only handle.
    /// @typeparam T The element type.
    /// @param writer The writer; `nil` disables the arm.
    /// @param value The value the arm offers.
    /// @param arm The arm index.
    func AddSend[T](writer ChannelWriter[T]?, value T, arm int32) {
        switch writer {
            case owned is Chan[T].ChanWriter {
                PlaceSend(owned.Owner, value, arm)
            }
            case nil { }
            default {
                Place(ForeignSendArm[T](writer!!, value, arm))
            }
        }
    }

    /// Adds a `case await task` arm.
    /// @param task The task.
    /// @param arm The arm index.
    func AddTask(task Task, arm int32) -> Place(TaskArm(task, arm))

    /// Adds a `case let v = await task` arm.
    /// @typeparam T The task result type.
    /// @param task The task.
    /// @param arm The arm index.
    func AddTask[T](task Task[T], arm int32) -> Place(TaskArm[T](task, arm))

    /// Adds a `case cancelled` arm. With it, cancellation of the ambient
    /// context selects this arm instead of throwing out of the select.
    /// @param arm The arm index.
    func AddCancelled(arm int32) -> cancelledArm = arm

    /// Registers every arm and parks. Completes with the winning arm index.
    /// Throws (cref:OperationCanceledException) when the ambient context
    /// is cancelled and no `cancelled` arm exists, (cref:ChannelClosedException)
    /// when a send arm's channel closes, or a winning task arm's fault.
    ///
    /// ADR-0174 D8, the `default` arm: probes every arm once, in uniform
    /// random order, and commits to the first that is ready — without
    /// registering, parking, or observing cancellation. Returns the winning arm,
    /// or `-1` when none is ready, in which case the caller takes its
    /// `default` arm.
    /// @returns The winning arm.
    /// @returns The winning arm index, or `-1`.
    func TryNow() int32 {
        let generation = Generation
        var completions = default(Completions)
        var won = false
        CollectGates()
        var taken = 0
        try {
            for ; taken < gates.Count; taken++ {
                Monitor.Enter(gates[taken].Gate)
            }
            let count = armCount
            let start = if count > 0 {
                SelectRandom.Next(count)
            } else {
                0
            }
            for var k = 0; k < count && !won; k++ {
                let descriptor = arms[(start + k) % count]
                if descriptor.RequiresGate && descriptor.TryProbe(this, &completions) {
                    Claim(generation, descriptor.Arm)
                    won = true
                }
            }
        } finally {
            for var i = taken - 1; i >= 0; i-- {
                Monitor.Exit(gates[i].Gate)
            }
        }
        completions.Publish()
        // Arms that lock privately or hold no lock at all — a foreign channel, a
        // timer, a task — are probed outside the gates, in the same rotation. A
        // `cancelled` arm joins that rotation as one more ready-or-not arm: an
        // already-cancelled context is ready, exactly as Go's `ctx.Done()` is a
        // ready channel, so `default` does not win over it (ADR-0174 D8).
        if !won {
            let hasCancelled = cancelledArm >= 0
            let count = armCount +
                (
                if hasCancelled {
                    1
                } else {
                    0
                }
            )
            let start = if count > 0 {
                SelectRandom.Next(count)
            } else {
                0
            }
            for var k = 0; k < count && !won; k++ {
                let slot = (start + k) % count
                if hasCancelled && slot == armCount {
                    if token.IsCancellationRequested {
                        Claim(generation, cancelledArm)
                        Deposit(nil, ok: true, needsReprobe: false)
                        won = true
                    }
                    continue
                }
                let descriptor = arms[slot]
                if !descriptor.RequiresGate && descriptor.TryProbe(this, &completions) {
                    Claim(generation, descriptor.Arm)
                    won = true
                }
            }
            completions.Publish()
        }
        if fault != nil {
            let captured = fault
            fault = nil
            throw captured
        }
        return if won {
            winnerArm
        } else {
            -1
        }
    }

    /// The blocking form of (cref:WaitAsync), for the synthesized root
    /// that may block (ADR-0174 D4). The compiler emits this and the async
    /// lowering rewrites it into an awaited (cref:WaitAsync) inside a
    /// state machine, exactly as it does for a scope's join.
    /// @returns The winning arm index.
    func Wait() int32 -> WaitAsync().AsTask().GetAwaiter().GetResult()

    /// Registers every arm and suspends until one wins.
    /// @returns The winning arm index.
    func WaitAsync() ValueTask[int32] {
        let generation = Generation
        var completions = default(Completions)
        var wonSynchronously = false
        // Phase 1: acquire every distinct gate in ascending order.
        CollectGates()
        var taken = 0
        try {
            for ; taken < gates.Count; taken++ {
                Monitor.Enter(gates[taken].Gate)
            }
            // Phase 2: re-probe the gated arms under the locks, from a random start.
            let count = armCount
            let start = if count > 0 {
                SelectRandom.Next(count)
            } else {
                0
            }
            for var k = 0; k < count && !wonSynchronously; k++ {
                let descriptor = arms[(start + k) % count]
                if descriptor.RequiresGate && descriptor.TryProbe(this, &completions) {
                    Claim(generation, descriptor.Arm)
                    wonSynchronously = true
                }
            }
            if !wonSynchronously && cancelledArm >= 0 && token.IsCancellationRequested {
                Claim(generation, cancelledArm)
                Deposit(nil, ok: true, needsReprobe: false)
                wonSynchronously = true
            }
            // Phase 3: register the gated arms while still holding every lock,
            // so no arm can become ready-and-unobserved mid-registration.
            if !wonSynchronously {
                for var index = 0; index < armCount; index++ {
                    let descriptor = arms[index]
                    if descriptor.RequiresGate {
                        descriptor.Register(this, generation)
                    }
                }
            }
        } finally {
            for var i = taken - 1; i >= 0; i-- {
                Monitor.Exit(gates[i].Gate)
            }
        }
        completions.Publish()
        if wonSynchronously {
            return if fault == nil {
                ValueTask[int32](winnerArm)
            } else {
                ValueTask.FromException[int32](fault!!)
            }
        }
        // Phase 4: arms that lock privately or have no lock (timers, foreign
        // channels, tasks) — they may claim synchronously during registration.
        for var index = 0; index < armCount; index++ {
            let descriptor = arms[index]
            if !descriptor.RequiresGate {
                descriptor.Register(this, generation)
            }
        }
        // Phase 5: the ambient cancellation, last, so a token that is already
        // cancelled resolves inline against a fully registered waiter.
        if token.CanBeCanceled {
            hasTokenRegistration = true
            tokenRegistration = token.UnsafeRegister(
                (state object?, _ CancellationToken) -> (cast[SelectWaiter](state!!)).OnCancelled(),
                this
            )
        }
        return ValueTask[int32](this, core.Version)
    }

    /// Takes the value delivered to the winning receive arm.
    /// @typeparam T The arm's element type.
    /// @returns The value, or the zero value when (cref:Ok) is false.
    func TakeValue[T]() T {
        // Issue #3902 S4: the winner keeps the value in its own typed field, so
        // the common path is a cast. The object? slot survives for the arms
        // that genuinely have nothing typed to hand over — a re-probe signal
        // carries no value at all.
        let owner = valueOwner
        valueOwner = nil
        if owner is IArmValue[T]typed {
            return typed.TakeArmValue()
        }
        let taken object? = value
        value = nil
        return if taken == nil {
            ReceiveResult[T].ZeroValue()
        } else {
            T(taken)
        }
    }

    /// Deregisters every losing arm, tears down callbacks, and pools the waiter. Call exactly once per
    /// (cref:Rent(int, Context)).
    func Return() {
        // Issue #3902 S4: the descriptors are NOT discarded — they are the
        // per-slot cache the next select reuses. Their targets are released so
        // a thread-cached waiter cannot pin the channels of a select that has
        // finished.
        for var i = 0; i < armCount; i++ {
            arms[i].Deregister()
            arms[i].Release()
        }
        if hasTokenRegistration {
            // False when the callback ran or is running: never reuse then.
            canPool &= tokenRegistration.Unregister()
        }
        armCount = 0
        gates.Clear()
        winnerArm = -1
        valueOwner = nil
        value = nil
        ok = false
        needsReprobe = false
        fault = nil
        token = default(CancellationToken)
        tokenRegistration = default(CancellationTokenRegistration)
        hasTokenRegistration = false
        cancelledArm = -1
        let generation = Generation
        Volatile.Write(&word, (generation << StateBits) | int64(StateIdle))
        if canPool {
            core.Reset()
            cache.Value = this
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[int32]) GetResult(token int16) int32 -> core.GetResult(token)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[int32]) GetStatus(token int16) ValueTaskSourceStatus -> core.GetStatus(token)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[int32]) OnCompleted(
        continuation(object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags
    ) -> core.OnCompleted(continuation, state, token, flags)

    /// The one CAS every claimer performs: `(generation, Pending) → (generation, Claimed)`.
    /// Fails for a stale generation (a pooled waiter reused since the
    /// registration was made) and for an already-claimed waiter.
    /// @param generation The generation the registration was made under.
    /// @param arm The arm claiming.
    /// @returns True when this call won.
    internal func TryClaim(generation int64, arm int32) bool {
        let expected = (generation << StateBits) | int64(StatePending)
        let desired = (generation << StateBits) | int64(StateClaimed)
        if Interlocked.CompareExchange(&word, desired, expected) != expected {
            return false
        }
        winnerArm = arm
        return true
    }

    /// Deposits a receive arm's outcome. Only the claimer calls this, after (cref:TryClaim).
    /// @param deposited The value (boxed for value types on the slow path).
    /// @param ok Whether a value was delivered.
    /// @param needsReprobe Whether the arm only signalled readiness.
    internal func Deposit(deposited object?, ok bool, needsReprobe bool) {
        value = deposited
        valueOwner = nil
        this.ok = ok
        this.needsReprobe = needsReprobe
    }

    /// Deposits an outcome whose value stays in [`owner`](paramref)'s typed
    /// field (issue #3902 S4), so a value-typed element never boxes.
    /// @param owner The arm or node holding the value.
    /// @param ok Whether a value was delivered.
    internal func DepositFrom(owner object, ok bool) {
        valueOwner = owner
        value = nil
        this.ok = ok
        needsReprobe = false
    }

    /// Deposits a fault the winning arm surfaces from (cref:WaitAsync).
    /// @param exception The fault.
    internal func DepositFault(exception Exception) -> fault = exception

    /// Fires the select's continuation. Called exactly once, by the claimer, outside every channel lock.
    internal func PublishOutcome() {
        // Issue #3902 H1: the select's continuation may run on the claiming
        // thread when the budget allows. Like a channel hand-off, the claim is
        // published outside every gate.
        let inline = InlineBudget.TryEnter()
        try {
            this.core.RunContinuationsAsynchronously = !inline
            if fault != nil {
                core.SetException(fault!!)
            } else {
                core.SetResult(winnerArm)
            }
        } finally {
            if inline {
                InlineBudget.Exit()
            }
        }
    }

    /// Collects the distinct gates of the gated arms, sorted ascending by their total-order key.
    /// @returns The sorted gate list (for tests).
    internal func CollectGates() IReadOnlyList[(Order int64, Gate object)] {
        gates.Clear()
        for var index = 0; index < armCount; index++ {
            let descriptor = arms[index]
            if descriptor.Gate is not{} gate {
                continue
            }
            var seen = false
            // An index loop, not `for existing in gates`: gsc lowers a `for-in` over a
            // `List` of NAMED tuples through `IEnumerable[T].GetEnumerator()` (so the
            // element names survive), which boxes the struct enumerator, 48 B per
            // iteration. That is what made every select allocate.
            for var g = 0; g < gates.Count; g++ {
                if object.ReferenceEquals(gates[g].Gate, gate) {
                    seen = true
                    break
                }
            }
            if !seen {
                gates.Add((descriptor.Order, gate))
            }
        }
        gates.Sort(GateOrder)
        return gates
    }

    /// Places a receive arm in the next slot, reusing the descriptor already
    /// cached there when it is the same shape (issue #3902 S4).
    /// @remarks The waiter is thread-cached and shared by every select on the thread, so
    /// slot 0 may be a `CoreReceiveArm<int>` in one select and a
    /// send arm over another element type in the next. The type test is what
    /// makes reuse safe: a hot loop over the same select allocates nothing after
    /// its first pass, and a thread that alternates shapes pays one allocation
    /// per change rather than one per arm per select.
    /// @typeparam T The element type.
    /// @param selectable The selectable to receive from.
    /// @param arm The arm index.
    private func PlaceReceive[T](selectable ISelectableCore[T], arm int32) {
        if armCount < arms.Count {
            if arms[armCount] is CoreReceiveArm[T]reusable {
                reusable.Retarget(selectable, arm)
            } else {
                arms[armCount] = CoreReceiveArm[T](selectable, arm)
            }
        } else {
            arms.Add(CoreReceiveArm[T](selectable, arm))
        }
        armCount++
    }

    /// Places a send arm; see (cref:PlaceReceive{T}) for the reuse rule.
    /// @typeparam T The element type.
    /// @param selectable The selectable to send to.
    /// @param value The value to send.
    /// @param arm The arm index.
    private func PlaceSend[T](selectable ISendSelectableCore[T], value T, arm int32) {
        if armCount < arms.Count {
            if arms[armCount] is CoreSendArm[T]reusable {
                reusable.Retarget(selectable, value, arm)
            } else {
                arms[armCount] = CoreSendArm[T](selectable, value, arm)
            }
        } else {
            arms.Add(CoreSendArm[T](selectable, value, arm))
        }
        armCount++
    }

    /// Places an arm shape that is not reused across selects (foreign channels, tasks).
    /// @param descriptor The descriptor.
    private func Place(descriptor ArmDescriptor) {
        if armCount < arms.Count {
            arms[armCount] = descriptor
        } else {
            arms.Add(descriptor)
        }
        armCount++
    }

    private func Begin(cancellationToken CancellationToken) {
        let generation = Generation + int64(1)
        Volatile.Write(&word, (generation << StateBits) | int64(StatePending))
        token = cancellationToken
        canPool = true
    }

    private func Claim(generation int64, arm int32) {
        if !TryClaim(generation, arm) {
            throw InvalidOperationException("select waiter was claimed while every gate was held")
        }
    }

    private func OnCancelled() {
        // Issue #3902 H1: this runs inside CancellationTokenSource.Cancel, so
        // an inline continuation would execute the select's body — arbitrary
        // user code — on whatever thread called Cancel, and inside the CTS's
        // own callback machinery. Publication here always queues.
        using let noInline = InlineBudget.Suppress()
        let generation = Generation
        if cancelledArm >= 0 {
            if TryClaim(generation, cancelledArm) {
                Deposit(nil, ok: true, needsReprobe: false)
                PublishOutcome()
            }
            return
        }
        if TryClaim(generation, -1) {
            DepositFault(OperationCanceledException(token))
            PublishOutcome()
        }
    }

    shared {
        private const StatePending int32 = 0
        private const StateClaimed int32 = 1
        private const StateIdle int32 = 2
        private const StateBits int32 = 2

        // The gate comparison is a cached static delegate: gsc does not (yet) cache a
        // non-capturing lambda the way Roslyn does, so a lambda written inline at the
        // `Sort` call would allocate a host object and a delegate on every select.
        private let GateOrder Comparison[(Order int64, Gate object)] =
            (a(Order int64, Gate object), b(Order int64, Gate object)) -> a.Order.CompareTo(b.Order)

        // Held in a ThreadLocal rather than a `@ThreadStatic` field: the bootstrap
        // compiler pinned in `global.json` drops `@ThreadStatic` on a `shared`
        // field (issue #4903), which made the pool one process-wide slot that
        // concurrent selects raced on. Revert once the pinned SDK carries the
        // emitter fix.
        private let cache ThreadLocal[SelectWaiter?] = ThreadLocal[SelectWaiter?]()

        /// Rents a waiter for [`arms`](paramref) arms, cancelled by
        /// [`context`](paramref) (ADR-0174 D7/D8). This is the overload the
        /// compiler emits: a `select` inside a cancelled scope unwinds.
        /// @param arms The number of arms.
        /// @param context The ambient context, or `null` for none.
        /// @returns A waiter; call (cref:Return()) when the select completes.
        func Rent(arms int32, context Context?) SelectWaiter -> Rent(arms, context?.Token ?? default(CancellationToken))

        /// Rents a waiter for [`arms`](paramref) arms under a token.
        /// @param arms The number of arms.
        /// @param cancellationToken The ambient cancellation.
        /// @returns A waiter; call (cref:Return()) when the select completes.
        func Rent(arms int32, cancellationToken CancellationToken) SelectWaiter {
            var waiter SelectWaiter? = cache.Value
            cache.Value = nil
            waiter ??= SelectWaiter()
            waiter!!.Begin(cancellationToken)
            return waiter!!
        }
    }
}
