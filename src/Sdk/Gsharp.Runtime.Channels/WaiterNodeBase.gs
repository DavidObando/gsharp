// <copyright file="WaiterNodeBase.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

/// The element-type-agnostic part of a parked node: the deferred publication
/// hook. A `select` spans channels of different element types, so the
/// list of nodes claimed under the locks has to be typed over this base.
internal abstract class WaiterNodeBase {
    /// Fires the node's continuation. Idempotent. Must be called outside every channel lock.
    internal open func Publish();
}
