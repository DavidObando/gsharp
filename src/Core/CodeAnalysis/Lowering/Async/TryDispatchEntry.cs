// <copyright file="TryDispatchEntry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>One entry in a user try's internal state dispatch.</summary>
internal readonly struct TryDispatchEntry
{
    /// <summary>Initializes a new instance of the <see cref="TryDispatchEntry"/> struct.</summary>
    /// <param name="state">The await state number.</param>
    /// <param name="target">The dispatch target label.</param>
    public TryDispatchEntry(int state, BoundLabel target)
    {
        State = state;
        Target = target;
    }

    /// <summary>Gets the await state number.</summary>
    public int State { get; }

    /// <summary>Gets the dispatch target label.</summary>
    public BoundLabel Target { get; }
}
