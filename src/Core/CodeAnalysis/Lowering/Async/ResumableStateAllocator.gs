// <copyright file="ResumableStateAllocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

/// Allocates deterministic state numbers for resumable async state-machine
/// points.
/// @remarks Await resume states and async-iterator yield resume states live in separate
/// numeric ranges. Await states count upward from `0`; async-iterator
/// yield states count downward from `-4`. This mirrors Roslyn's state
/// numbering and keeps `-1`, `-2`, and `-3` reserved for the
/// non-resumable states in (cref:StateMachineStates).
class ResumableStateAllocator {
    private var nextAwaitState int32 = StateMachineStates.FirstResumableAsyncState
    private var nextYieldState int32 = StateMachineStates.FirstResumableAsyncIteratorState

    /// Gets the number of await resume states allocated so far.
    prop AwaitStateCount int32 -> nextAwaitState - StateMachineStates.FirstResumableAsyncState

    /// Gets the number of async-iterator yield resume states allocated so far.
    prop YieldStateCount int32 -> StateMachineStates.FirstResumableAsyncIteratorState - nextYieldState

    /// Allocates the next state number for a suspending `await`.
    /// @returns The next monotonically increasing await resume state.
    func AllocateAwaitState() int32 {
        return nextAwaitState++
    }

    /// Allocates the next state number for a suspending async-iterator
    /// `yield return`.
    /// @returns The next monotonically decreasing yield resume state.
    func AllocateYieldState() int32 {
        return nextYieldState--
    }
}
