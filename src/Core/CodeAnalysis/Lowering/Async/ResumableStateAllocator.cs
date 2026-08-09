// <copyright file="ResumableStateAllocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Allocates deterministic state numbers for resumable async state-machine
/// points.
/// </summary>
/// <remarks>
/// Await resume states and async-iterator yield resume states live in separate
/// numeric ranges. Await states count upward from <c>0</c>; async-iterator
/// yield states count downward from <c>-4</c>. This mirrors Roslyn's state
/// numbering and keeps <c>-1</c>, <c>-2</c>, and <c>-3</c> reserved for the
/// non-resumable states in <see cref="StateMachineStates"/>.
/// </remarks>
public sealed class ResumableStateAllocator
{
    private int nextAwaitState = StateMachineStates.FirstResumableAsyncState;
    private int nextYieldState = StateMachineStates.FirstResumableAsyncIteratorState;

    /// <summary>
    /// Gets the number of await resume states allocated so far.
    /// </summary>
    public int AwaitStateCount => nextAwaitState - StateMachineStates.FirstResumableAsyncState;

    /// <summary>
    /// Gets the number of async-iterator yield resume states allocated so far.
    /// </summary>
    public int YieldStateCount => StateMachineStates.FirstResumableAsyncIteratorState - nextYieldState;

    /// <summary>
    /// Allocates the next state number for a suspending <c>await</c>.
    /// </summary>
    /// <returns>The next monotonically increasing await resume state.</returns>
    public int AllocateAwaitState()
    {
        return nextAwaitState++;
    }

    /// <summary>
    /// Allocates the next state number for a suspending async-iterator
    /// <c>yield return</c>.
    /// </summary>
    /// <returns>The next monotonically decreasing yield resume state.</returns>
    public int AllocateYieldState()
    {
        return nextYieldState--;
    }
}
