// <copyright file="WaiterNodeBase.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The element-type-agnostic part of a parked node: the deferred publication
/// hook. A <c>select</c> spans channels of different element types, so the
/// list of nodes claimed under the locks has to be typed over this base.
/// </summary>
internal abstract class WaiterNodeBase
{
    /// <summary>Fires the node's continuation. Idempotent. Must be called outside every channel lock.</summary>
    internal abstract void Publish();
}
