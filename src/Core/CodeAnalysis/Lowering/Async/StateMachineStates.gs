// <copyright file="StateMachineStates.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

/// Canonical magic state numbers used by the async state-machine rewriter
/// (see `~/roslyn-async.md` §6.2 and Roslyn's
/// `Core/Portable/CodeGen/StateMachineState.cs`).
/// @remarks The CLR builders rely on these values implicitly. For example,
/// `AsyncTaskMethodBuilder.Start` calls `MoveNext` exactly once;
/// the state machine must enter that call with (cref:NotStartedOrRunningState)
/// (`-1`) so the state-dispatch switch falls through to the first user
/// statement instead of branching to a resume label.
shared class StateMachineStates {
    /// Initial state set by the kickoff before `builder.Start`;
    /// also the value the state-machine restores between resume and the next
    /// suspension (spec §6.2).
    const NotStartedOrRunningState int32 = -1

    /// Terminal state set immediately before `SetResult` or
    /// `SetException` (spec §6.2, §12 corner case 7).
    const FinishedState int32 = -2

    /// Initial state for async-iterators (`async IAsyncEnumerable<T>`).
    /// Yield states decrease from this value; await states still increase
    /// from (cref:FirstResumableAsyncState) (spec §10).
    const InitialAsyncIteratorState int32 = -3

    /// First state number allocated to a suspending `await`;
    /// subsequent awaits get monotonically increasing values.
    const FirstResumableAsyncState int32 = 0

    /// First state number allocated to a suspending `yield`;
    /// subsequent yields decrease from here (async-iterator only).
    const FirstResumableAsyncIteratorState int32 = InitialAsyncIteratorState - 1
}
