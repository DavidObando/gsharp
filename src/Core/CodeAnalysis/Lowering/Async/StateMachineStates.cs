// <copyright file="StateMachineStates.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Canonical magic state numbers used by the async state-machine rewriter
/// (see <c>~/roslyn-async.md</c> §6.2 and Roslyn's
/// <c>Core/Portable/CodeGen/StateMachineState.cs</c>).
/// </summary>
/// <remarks>
/// The CLR builders rely on these values implicitly. For example,
/// <c>AsyncTaskMethodBuilder.Start</c> calls <c>MoveNext</c> exactly once;
/// the state machine must enter that call with <see cref="NotStartedOrRunningState"/>
/// (<c>-1</c>) so the state-dispatch switch falls through to the first user
/// statement instead of branching to a resume label.
/// </remarks>
public static class StateMachineStates
{
    /// <summary>Initial state set by the kickoff before <c>builder.Start</c>;
    /// also the value the state-machine restores between resume and the next
    /// suspension (spec §6.2).</summary>
    public const int NotStartedOrRunningState = -1;

    /// <summary>Terminal state set immediately before <c>SetResult</c> or
    /// <c>SetException</c> (spec §6.2, §12 corner case 7).</summary>
    public const int FinishedState = -2;

    /// <summary>Initial state for async-iterators (<c>async IAsyncEnumerable&lt;T&gt;</c>).
    /// Yield states decrease from this value; await states still increase
    /// from <see cref="FirstResumableAsyncState"/> (spec §10).</summary>
    public const int InitialAsyncIteratorState = -3;

    /// <summary>First state number allocated to a suspending <c>await</c>;
    /// subsequent awaits get monotonically increasing values.</summary>
    public const int FirstResumableAsyncState = 0;

    /// <summary>First state number allocated to a suspending <c>yield</c>;
    /// subsequent yields decrease from here (async-iterator only).</summary>
    public const int FirstResumableAsyncIteratorState = InitialAsyncIteratorState - 1;
}
