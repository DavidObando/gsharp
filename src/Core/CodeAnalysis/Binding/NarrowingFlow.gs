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
    private let narrowedVariables Dictionary[AccessPath, TypeSymbol]
    private let narrowingFrameIndices Dictionary[AccessPath, int32]
    private var externalCallableAliases ImmutableHashSet[VariableSymbol]

    init(
        narrowedVariables IReadOnlyDictionary[AccessPath, TypeSymbol],
        narrowingFrameIndices IReadOnlyDictionary[AccessPath, int32],
        externalCallableAliases IReadOnlyCollection[VariableSymbol],
        activeCleanupRegions ImmutableArray[GotoCleanupRegion]
    ) {
        this.narrowedVariables = Dictionary[AccessPath, TypeSymbol](narrowedVariables)
        this.narrowingFrameIndices = Dictionary[AccessPath, int32](narrowingFrameIndices)
        NarrowedVariables = ReadOnlyDictionary[AccessPath, TypeSymbol](this.narrowedVariables)
        NarrowingFrameIndices = ReadOnlyDictionary[AccessPath, int32](this.narrowingFrameIndices)
        this.externalCallableAliases = externalCallableAliases.ToImmutableHashSet()
        ActiveCleanupRegions = activeCleanupRegions
    }

    prop NarrowedVariables IReadOnlyDictionary[AccessPath, TypeSymbol] {
        get;
    }

    prop NarrowingFrameIndices IReadOnlyDictionary[AccessPath, int32] {
        get;
    }

    prop ExternalCallableAliases ImmutableHashSet[VariableSymbol] -> externalCallableAliases

    prop ActiveCleanupRegions ImmutableArray[GotoCleanupRegion] {
        get;
    }

    func Clone() NarrowingJumpState -> NarrowingJumpState(
        narrowedVariables,
        NarrowingFrameIndices,
        ExternalCallableAliases,
        ActiveCleanupRegions
    )

    func RemoveNarrowing(path AccessPath) {
        narrowedVariables.Remove(path)
        narrowingFrameIndices.Remove(path)
    }

    func SetNarrowing(path AccessPath, type TypeSymbol) {
        narrowedVariables[path] = type
        narrowingFrameIndices.Remove(path)
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
    prop HasPendingJumps bool -> pending.Count > 0

    /// Records a forward jump state on [`target`](paramref) with the cleanup regions still to run.
    func RecordJump(target string, state NarrowingJumpState) {
        if !pending.TryGetValue(target, out var states) {
            states = List[NarrowingJumpState]()
            pending[target] = states
        }
        states.Add(state)
    }

    /// Removes and returns the recorded forward jump states for [`target`](paramref), or `nil`.
    func TakeJumps(target string) List[NarrowingJumpState]? {
        if pending.Remove(target, out var states) {
            return states
        }
        return nil
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
