// <copyright file="SelectOrder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Threading

/// The process-wide total order every selectable draws its key from
/// (ADR-0174 D8 step 6). Deliberately non-generic: a static field on
/// `Chan<T>` would be one counter per element type, and a
/// `select` over a `chan[int32]` and a `chan[string]` needs one order.
internal shared class SelectOrder {
    private var next int64

    /// Allocates the next key.
    /// @returns A key strictly greater than every key allocated before it.
    internal func Next() int64 -> Interlocked.Increment(&next)
}
