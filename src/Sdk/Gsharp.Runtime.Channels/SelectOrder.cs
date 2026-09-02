// <copyright file="SelectOrder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The process-wide total order every selectable draws its key from
/// (ADR-0174 D8 step 6). Deliberately non-generic: a static field on
/// <c>Chan&lt;T&gt;</c> would be one counter per element type, and a
/// <c>select</c> over a <c>chan[int32]</c> and a <c>chan[string]</c> needs one order.
/// </summary>
internal static class SelectOrder
{
    private static long next;

    /// <summary>Allocates the next key.</summary>
    /// <returns>A key strictly greater than every key allocated before it.</returns>
    internal static long Next() => Interlocked.Increment(ref next);
}
