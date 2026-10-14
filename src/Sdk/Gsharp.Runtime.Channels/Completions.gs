// <copyright file="Completions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Collections.Generic

/// Nodes claimed under a channel lock whose continuations fire after it is
/// released. Zero allocations for the common one-node case.
internal struct Completions {
    private var first WaiterNodeBase?
    private var rest List[WaiterNodeBase]?

    /// Records a node to publish.
    /// @param node The claimed node.
    func Add(node WaiterNodeBase) {
        if first == nil {
            first = node
            return
        }
        rest ??= List[WaiterNodeBase]()
        rest!!.Add(node)
    }

    /// Publishes every recorded node.
    func Publish() {
        first?.Publish()
        if rest != nil {
            for node in rest!! {
                node.Publish()
            }
        }
    }
}
