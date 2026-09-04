// <copyright file="Completions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// Nodes claimed under a channel lock whose continuations fire after it is
/// released. Zero allocations for the common one-node case.
/// </summary>
internal struct Completions
{
    private WaiterNodeBase? first;
    private List<WaiterNodeBase>? rest;

    /// <summary>Records a node to publish.</summary>
    /// <param name="node">The claimed node.</param>
    public void Add(WaiterNodeBase node)
    {
        if (first is null)
        {
            first = node;
            return;
        }

        rest ??= new List<WaiterNodeBase>();
        rest.Add(node);
    }

    /// <summary>Publishes every recorded node.</summary>
    public void Publish()
    {
        first?.Publish();
        if (rest is not null)
        {
            foreach (var node in rest)
            {
                node.Publish();
            }
        }
    }
}
