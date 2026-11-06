// <copyright file="NarrowingFlow.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Collections.ObjectModel

/// Forward jump state recorded for a user label (ADR-0208 section 7, ADR-0213 section 11).
internal sealed class NarrowingJumpState {
    private let frameSnapshots ImmutableArray[NarrowingFrameSnapshot?]
    private var overrides ImmutableDictionary[AccessPath, TypeSymbol?]
    private var externalCallableAliases ImmutableHashSet[VariableSymbol]

    init(
        frameSnapshots ImmutableArray[NarrowingFrameSnapshot?],
        externalCallableAliases IReadOnlyCollection[VariableSymbol],
        activeCleanupRegions ImmutableArray[GotoCleanupRegion],
        breakNode BoundStatement? = nil
    ) {
        this.frameSnapshots = frameSnapshots
        this.overrides = ImmutableDictionary[AccessPath, TypeSymbol?].Empty
        this.externalCallableAliases = externalCallableAliases.ToImmutableHashSet()
        ActiveCleanupRegions = activeCleanupRegions
        BreakNode = breakNode
    }

    private init(
        frameSnapshots ImmutableArray[NarrowingFrameSnapshot?],
        overrides ImmutableDictionary[AccessPath, TypeSymbol?],
        externalCallableAliases ImmutableHashSet[VariableSymbol],
        activeCleanupRegions ImmutableArray[GotoCleanupRegion],
        breakNode BoundStatement?
    ) {
        this.frameSnapshots = frameSnapshots
        this.overrides = overrides
        this.externalCallableAliases = externalCallableAliases
        ActiveCleanupRegions = activeCleanupRegions
        BreakNode = breakNode
    }

    prop ExternalCallableAliases ImmutableHashSet[VariableSymbol] -> externalCallableAliases

    prop ActiveCleanupRegions ImmutableArray[GotoCleanupRegion] {
        get;
    }

    prop BreakNode BoundStatement? {
        get;
    }

    func TryGetNarrowedVariable(path AccessPath, out narrowedType TypeSymbol) bool {
        if !overrides.IsEmpty && overrides.TryGetValue(path, out var overridden) {
            if overridden == nil {
                narrowedType = TypeSymbol.Error
                return false
            }
            narrowedType = overridden
            return true
        }
        if !frameSnapshots.IsDefaultOrEmpty {
            for var i = frameSnapshots.Length - 1; i >= 0; i-- {
                let snap = frameSnapshots[i]
                if snap != nil && snap.TryGetValue(path, out narrowedType) {
                    return true
                }
            }
        }
        narrowedType = TypeSymbol.Error
        return false
    }

    func TryGetNarrowingFrameIndex(path AccessPath, out frameIndex int32) bool {
        if !overrides.IsEmpty && overrides.ContainsKey(path) {
            frameIndex = -1
            return false
        }
        if !frameSnapshots.IsDefaultOrEmpty {
            for var i = frameSnapshots.Length - 1; i >= 0; i-- {
                let snap = frameSnapshots[i]
                if snap != nil && snap.ContainsKey(path) {
                    frameIndex = i
                    return true
                }
            }
        }
        frameIndex = -1
        return false
    }

    func GetNarrowedVariablesSnapshot() Dictionary[AccessPath, TypeSymbol] {
        let result = Dictionary[AccessPath, TypeSymbol]()
        if !frameSnapshots.IsDefaultOrEmpty {
            for var i = 0; i < frameSnapshots.Length; i++ {
                let snap = frameSnapshots[i]
                if snap != nil {
                    for entry in snap.GetMap() {
                        result[entry.Key] = entry.Value
                    }
                }
            }
        }
        if !overrides.IsEmpty {
            for entry in overrides {
                if entry.Value == nil {
                    result.Remove(entry.Key)
                } else {
                    result[entry.Key] = entry.Value!!
                }
            }
        }
        return result
    }

    func Clone() NarrowingJumpState {
        StatementBinder.SpeculativeRollbackWorkCount += overrides.Count
        return NarrowingJumpState(frameSnapshots, overrides, externalCallableAliases, ActiveCleanupRegions, BreakNode)
    }

    func RemoveNarrowing(path AccessPath) {
        overrides = overrides.SetItem(path, nil)
    }

    func SetNarrowing(path AccessPath, type TypeSymbol) {
        overrides = overrides.SetItem(path, type)
    }

    func ReplaceExternalCallableAliases(aliases IEnumerable[VariableSymbol]) {
        externalCallableAliases = aliases.ToImmutableHashSet()
    }
}

/// Per-body jump states waiting for their target labels (ADR-0208 section 7, ADR-0213 section 11).
internal sealed class NarrowingFlow {
    private let pending Dictionary[string, List[NarrowingJumpState]] = Dictionary[string, List[NarrowingJumpState]](
        StringComparer.Ordinal
    )

    /// Gets a value indicating whether any forward jump state is waiting for its target label.
    prop HasPendingJumps bool {
        get {
            for key in pending.Keys {
                if !key.StartsWith("#", StringComparison.Ordinal) {
                    return true
                }
            }
            return false
        }
    }

    /// Gets or sets a callback notified before a target's pending jump list is mutated.
    internal var OnTargetTouching((string) -> void)?

    /// Gets or sets a callback notified before a target's pending jump list is removed by (cref:TakeJumps).
    internal var OnTargetRemoving((string, IReadOnlyList[NarrowingJumpState]) -> void)?

    /// Records a `break` state on [`target`](paramref) with the cleanup regions still to run (ADR-0213 table 9, J1).
    func RecordBreak(target BoundLabel, state NarrowingJumpState) -> RecordJump("#" + target.Name, state)

    /// Removes and returns the recorded `break` states for [`target`](paramref), or `nil`.
    func TakeBreaks(target BoundLabel) List[NarrowingJumpState]? -> TakeJumps("#" + target.Name)

    /// Records a forward jump state on [`target`](paramref) with the cleanup regions still to run.
    func RecordJump(target string, state NarrowingJumpState) {
        OnTargetTouching?(target)
        if !pending.TryGetValue(target, out var states) {
            states = List[NarrowingJumpState]()
            pending[target] = states
        }
        states.Add(state)
    }

    /// Removes and returns the recorded forward jump states for [`target`](paramref), or `nil`.
    func TakeJumps(target string) List[NarrowingJumpState]? {
        if !pending.TryGetValue(target, out var states) {
            return nil
        }
        OnTargetTouching?(target)
        OnTargetRemoving?(target, states)
        pending.Remove(target)
        return states
    }

    /// Returns the number of recorded jump states for [`target`](paramref), or `-1` when [`target`](paramref)
    /// has no pending jump list.
    func GetJumpCount(target string) int32 {
        if pending.TryGetValue(target, out var states) {
            return states.Count
        }
        return -1
    }

    /// Copies the recorded jump states for [`target`](paramref) starting at [`startIndex`](paramref), or `nil`.
    func CloneRange(target string, startIndex int32)[]?NarrowingJumpState {
        if !pending.TryGetValue(target, out var states) || startIndex >= states.Count {
            return nil
        }
        let count = states.Count - startIndex
        let copy = [count]NarrowingJumpState
        for var i = 0; i < count; i++ {
            copy[i] = states[startIndex + i].Clone()
        }
        return copy
    }

    /// Truncates the recorded jump states for [`target`](paramref) to [`count`](paramref), or removes the target
    /// when [`count`](paramref) is negative.
    func TruncateTarget(target string, count int32) {
        if count < 0 {
            pending.Remove(target)
            return
        }
        if !pending.TryGetValue(target, out var states) {
            pending[target] = List[NarrowingJumpState]()
            return
        }
        if states.Count > count {
            states.RemoveRange(count, states.Count - count)
        }
    }

    /// Appends cloned jump states to [`target`](paramref), creating the target list when needed.
    func AppendTarget(target string, statesToAppend[]?NarrowingJumpState) {
        if !pending.TryGetValue(target, out var states) {
            states = List[NarrowingJumpState](statesToAppend?.Length ?? 0)
            pending[target] = states
        }
        if statesToAppend != nil {
            for state in statesToAppend {
                states.Add(state.Clone())
            }
        }
    }

    /// Replaces the recorded jump states for [`target`](paramref) with a cloned snapshot.
    func RestoreTarget(target string, snapshot[]?NarrowingJumpState, keepEmptyList bool = false) {
        if snapshot == nil {
            if keepEmptyList {
                pending[target] = List[NarrowingJumpState]()
            } else {
                pending.Remove(target)
            }
            return
        }
        let list = List[NarrowingJumpState](snapshot.Length)
        for state in snapshot {
            list.Add(state.Clone())
        }
        pending[target] = list
    }

    /// Returns the recorded forward jump states for [`target`](paramref) without removing them, or `nil`.
    func PeekJumps(target string) IReadOnlyList[NarrowingJumpState]? {
        if pending.TryGetValue(target, out var states) {
            return states
        }
        return nil
    }

    /// Removes all recorded jump states.
    func Clear() {
        pending.Clear()
    }

    /// Copies all recorded jump states.
    func Clone() Dictionary[string, List[NarrowingJumpState]] {
        let copy = Dictionary[string, List[NarrowingJumpState]](StringComparer.Ordinal)
        for entry in pending {
            let list = List[NarrowingJumpState](entry.Value.Count)
            for state in entry.Value {
                list.Add(state.Clone())
            }
            copy[entry.Key] = list
        }
        return copy
    }

    /// Replaces the recorded jump states with a cloned snapshot.
    func Restore(snapshot Dictionary[string, List[NarrowingJumpState]]) {
        pending.Clear()
        for entry in snapshot {
            let list = List[NarrowingJumpState](entry.Value.Count)
            for state in entry.Value {
                list.Add(state.Clone())
            }
            pending[entry.Key] = list
        }
    }
}
