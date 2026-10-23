// <copyright file="EmitScratch.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Reflection.Metadata.Ecma335
import System.Threading

/// A small thread-safe free list of reusable scratch objects. One pool belongs
/// to one emitter, so no state is shared between compilations.
/// @remarks `Rent` gives out a (cref:ScratchLease). Only the first `Release` of a
/// lease resets the item and makes it free again, so a second release (even after
/// another caller rented the same item) does nothing. The item is reset while its
/// releaser is the only owner, before it is published to the free list. An item
/// that `reset` rejects (for example one that kept too much storage) is dropped.
/// An item whose lease is never released (for example after an exception that
/// skips the caller's cleanup) is simply collected; the pool never holds a
/// partly used item.
internal class ScratchPool[T] {
    private const MaxRetained int32 = 8
    private let counterPrefix string
    private let create Func[T]
    private let reset Func[T, bool]
    private let free Stack[T] = Stack[T]()

    init(counterPrefix string, create Func[T], reset Func[T, bool]) {
        this.counterPrefix = counterPrefix
        this.create = create
        this.reset = reset
    }

    /// Gets the number of items currently waiting for reuse.
    func GetFreeCount() int32 {
        lock this.free {
            return this.free.Count
        }
    }

    /// Takes a cleared item, creating one when none is free.
    func Rent() ScratchLease[T] {
        lock this.free {
            if this.free.Count > 0 {
                CompilationMeasurements.Count(this.counterPrefix + ".reused")
                return ScratchLease[T](this, this.free.Pop())
            }
        }
        CompilationMeasurements.Count(this.counterPrefix + ".created")
        return ScratchLease[T](this, this.create())
    }

    /// Resets and publishes an item whose lease was just released. Called by the lease only.
    internal func Accept(item T) {
        // The releasing lease is the only owner here, so the reset needs no lock.
        if !this.reset(item) {
            CompilationMeasurements.Count(this.counterPrefix + ".dropped")
            return
        }
        lock this.free {
            if this.free.Count < MaxRetained {
                this.free.Push(item)
            }
        }
    }
}

/// One loan of a pooled item. Release it once the item is no longer used.
internal class ScratchLease[T] {
    private let pool ScratchPool[T]
    private var released int32

    internal init(pool ScratchPool[T], item T) {
        this.pool = pool
        Item = item
    }

    /// Gets the borrowed item. Do not use it after (cref:Release).
    prop Item T {
        get;
    }

    /// Gives the item back. Later calls on the same lease do nothing.
    func Release() {
        if Interlocked.Exchange(&this.released, 1) == 0 {
            this.pool.Accept(Item)
        }
    }
}

/// The reusable collections of one method-body planning pass: the sinks that
/// the slot collectors fill. Each collector clears its sink before it walks, and
/// the pool clears all of them again on release so no bound node stays reachable.
internal class PlannerScratch {
    internal let StructLiterals List[BoundStructLiteralExpression] = List[BoundStructLiteralExpression]()
    internal let NullConditionals List[BoundNullConditionalAccessExpression] = List[
        BoundNullConditionalAccessExpression
    ]()
    internal let MapIndexReads List[BoundIndexExpression] = List[BoundIndexExpression]()
    internal let DefaultExpressions List[BoundDefaultExpression] = List[BoundDefaultExpression]()
    internal let StackAllocs List[BoundStackAllocExpression] = List[BoundStackAllocExpression]()
    internal let RootStackAllocs HashSet[BoundStackAllocExpression] = HashSet[BoundStackAllocExpression]()
    internal let ReceiverSpills List[BoundExpression] = List[BoundExpression]()
    internal let IndexAssignmentValueSpills List[BoundExpression] = List[BoundExpression]()
    internal let AssignmentValueSpills List[BoundExpression] = List[BoundExpression]()
    internal let NullableUnwraps List[BoundUnaryExpression] = List[BoundUnaryExpression]()
    internal let NullableCoalesces List[BoundBinaryExpression] = List[BoundBinaryExpression]()
    internal let LiftedBinaryOperators List[BoundExpression] = List[BoundExpression]()
    internal let NullableConversions List[BoundExpression] = List[BoundExpression]()

    /// Gets the number of times this scratch was cleared for reuse. Zero means no body has used it yet.
    prop Clears int32 {
        get;
        private set;
    }

    /// Gets the storage the collectors keep after a `Clear`: list capacities and hash table sizes.
    /// A collector that grew in an earlier planning region keeps its storage when a later
    /// region clears it, so the count of live entries cannot tell how large the scratch is.
    prop RetainedCapacity int32 -> this
        .StructLiterals
        .Capacity +
        this
        .NullConditionals
        .Capacity +
        this
        .MapIndexReads
        .Capacity +
        this
        .DefaultExpressions
        .Capacity +
        this
        .StackAllocs
        .Capacity +
        this
        .RootStackAllocs
        .EnsureCapacity(0) +
        this
        .ReceiverSpills
        .Capacity +
        this
        .IndexAssignmentValueSpills
        .Capacity +
        this
        .AssignmentValueSpills
        .Capacity +
        this
        .NullableUnwraps
        .Capacity +
        this
        .NullableCoalesces
        .Capacity +
        this
        .LiftedBinaryOperators
        .Capacity +
        this
        .NullableConversions
        .Capacity

    /// Gets the total number of elements still held (zero after `Clear`).
    prop HeldCount int32 -> this
        .StructLiterals
        .Count +
        this
        .NullConditionals
        .Count +
        this
        .MapIndexReads
        .Count +
        this
        .DefaultExpressions
        .Count +
        this
        .StackAllocs
        .Count +
        this
        .RootStackAllocs
        .Count +
        this
        .ReceiverSpills
        .Count +
        this
        .IndexAssignmentValueSpills
        .Count +
        this
        .AssignmentValueSpills
        .Count +
        this
        .NullableUnwraps
        .Count +
        this
        .NullableCoalesces
        .Count +
        this
        .LiftedBinaryOperators
        .Count +
        this
        .NullableConversions
        .Count

    func Clear() {
        this.StructLiterals.Clear()
        this.NullConditionals.Clear()
        this.MapIndexReads.Clear()
        this.DefaultExpressions.Clear()
        this.StackAllocs.Clear()
        this.RootStackAllocs.Clear()
        this.ReceiverSpills.Clear()
        this.IndexAssignmentValueSpills.Clear()
        this.AssignmentValueSpills.Clear()
        this.NullableUnwraps.Clear()
        this.NullableCoalesces.Clear()
        this.LiftedBinaryOperators.Clear()
        this.NullableConversions.Clear()
        Clears++
    }
}

/// The slot-tracking collections of one method-body emit session. Instances
/// are reused across bodies through a (cref:ScratchPool).
internal class SessionScratch {
    /// Largest total retained storage (entries plus unused capacity) that is worth keeping for the next body.
    internal const MaxRetainedEntries int32 = 8192

    internal let Locals Dictionary[VariableSymbol, int32] = Dictionary[VariableSymbol, int32]()
    internal let Labels Dictionary[BoundLabel, LabelHandle] = Dictionary[BoundLabel, LabelHandle]()
    internal let LocalTypes List[TypeSymbol] = List[TypeSymbol]()
    internal let StructLiteralSlots Dictionary[BoundStructLiteralExpression, int32] = Dictionary[
        BoundStructLiteralExpression,
        int32
    ]()
    internal let DefaultExpressionSlots Dictionary[BoundDefaultExpression, int32] = Dictionary[
        BoundDefaultExpression,
        int32
    ]()
    internal let MapIndexSlots Dictionary[BoundIndexExpression, int32] = Dictionary[BoundIndexExpression, int32]()
    internal let PatternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32] = Dictionary[
        BoundPatternSwitchStatement,
        int32
    ]()
    internal let TypePatternScratchSlots Dictionary[BoundTypePattern, int32] = Dictionary[BoundTypePattern, int32]()
    internal let SwitchExpressionSlots Dictionary[
        BoundSwitchExpression,
        (Result int32, Discriminant int32)
    ] = Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)]()
    internal let ChannelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)] = Dictionary[
        BoundNode,
        (VT int32, TA int32, Result int32, Spare int32)
    ]()
    internal let ReceiverSpillSlots Dictionary[BoundExpression, int32] = Dictionary[BoundExpression, int32]()
    internal let StackAllocResultSlots Dictionary[BoundStackAllocExpression, int32] = Dictionary[
        BoundStackAllocExpression,
        int32
    ]()
    internal let IndexAssignmentValueSlots Dictionary[BoundExpression, int32] = Dictionary[BoundExpression, int32]()
    internal let LiftedBinaryOperatorSlots Dictionary[BoundExpression, LiftedBinarySlots] = Dictionary[
        BoundExpression,
        LiftedBinarySlots
    ]()
    internal let NullableCoalesceSpillSlots Dictionary[BoundBinaryExpression, int32] = Dictionary[
        BoundBinaryExpression,
        int32
    ]()
    internal let ConstValues Dictionary[VariableSymbol, object] = Dictionary[VariableSymbol, object]()
    private var planner PlannerScratch?

    /// Gets the planner collectors that belong to this scratch, creating them on first use.
    func GetPlanner() PlannerScratch {
        if this.planner == nil {
            this.planner = PlannerScratch()
        }
        return this.planner!!
    }

    /// Gets the total number of entries held by the collections (zero after `Reset`).
    prop HeldCount int32 -> this
        .Locals
        .Count +
        this
        .Labels
        .Count +
        this
        .LocalTypes
        .Count +
        this
        .StructLiteralSlots
        .Count +
        this
        .DefaultExpressionSlots
        .Count +
        this
        .MapIndexSlots
        .Count +
        this
        .PatternSwitchSlots
        .Count +
        this
        .TypePatternScratchSlots
        .Count +
        this
        .SwitchExpressionSlots
        .Count +
        this
        .ChannelOpSlots
        .Count +
        this
        .ReceiverSpillSlots
        .Count +
        this
        .StackAllocResultSlots
        .Count +
        this
        .IndexAssignmentValueSlots
        .Count +
        this
        .LiftedBinaryOperatorSlots
        .Count +
        this
        .NullableCoalesceSpillSlots
        .Count +
        this
        .ConstValues
        .Count +
        (this.planner?.HeldCount ?? 0)

    /// Gets the storage the collections keep, counting unused capacity. It stays high after
    /// `Reset` for a collection that grew, which is why `Reset` decides on it and not on `HeldCount`.
    prop RetainedCapacity int32 -> this.Locals.EnsureCapacity(0) + this.Labels.EnsureCapacity(0) +
        this
        .LocalTypes
        .Capacity +
        this
        .StructLiteralSlots
        .EnsureCapacity(0) + this.DefaultExpressionSlots.EnsureCapacity(0) + this.MapIndexSlots.EnsureCapacity(0) +
        this
        .PatternSwitchSlots
        .EnsureCapacity(0) + this.TypePatternScratchSlots.EnsureCapacity(0) + this.SwitchExpressionSlots.EnsureCapacity(
        0
    ) +
        this
        .ChannelOpSlots
        .EnsureCapacity(0) + this.ReceiverSpillSlots.EnsureCapacity(0) + this.StackAllocResultSlots.EnsureCapacity(0) +
        this
        .IndexAssignmentValueSlots
        .EnsureCapacity(0) + this.LiftedBinaryOperatorSlots.EnsureCapacity(0) +
        this
        .NullableCoalesceSpillSlots
        .EnsureCapacity(0) + this.ConstValues.EnsureCapacity(0) + (this.planner?.RetainedCapacity ?? 0)

    /// Empties every collection. Returns `false` when the scratch keeps too much storage to reuse.
    func Reset() bool {
        let keep = this.RetainedCapacity <= MaxRetainedEntries
        this.Locals.Clear()
        this.Labels.Clear()
        this.LocalTypes.Clear()
        this.StructLiteralSlots.Clear()
        this.DefaultExpressionSlots.Clear()
        this.MapIndexSlots.Clear()
        this.PatternSwitchSlots.Clear()
        this.TypePatternScratchSlots.Clear()
        this.SwitchExpressionSlots.Clear()
        this.ChannelOpSlots.Clear()
        this.ReceiverSpillSlots.Clear()
        this.StackAllocResultSlots.Clear()
        this.IndexAssignmentValueSlots.Clear()
        this.LiftedBinaryOperatorSlots.Clear()
        this.NullableCoalesceSpillSlots.Clear()
        this.ConstValues.Clear()
        this.planner?.Clear()
        return keep
    }
}
