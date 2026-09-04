// <copyright file="IArmValue{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// A select participant that holds the winning value in its own typed field
/// (issue #3902 S4).
/// </summary>
/// <remarks>
/// <see cref="SelectWaiter"/> is not generic, so it used to take the winning
/// value as <c>object?</c> — which boxed every value-typed element on both the
/// ready and the parked path. The value now stays with whichever participant
/// produced it (the arm descriptor when the probe succeeded, the parked node
/// when the transfer did), and <c>TakeValue&lt;T&gt;</c> reaches it through
/// this interface: a cast, not a box.
/// </remarks>
/// <typeparam name="T">The element type.</typeparam>
internal interface IArmValue<out T>
{
    /// <summary>Takes the deposited value, clearing it. Called once, by the winner.</summary>
    /// <returns>The value.</returns>
    T TakeArmValue();
}
