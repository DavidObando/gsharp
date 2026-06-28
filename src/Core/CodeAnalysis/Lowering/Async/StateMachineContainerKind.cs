#nullable disable

// <copyright file="StateMachineContainerKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Storage kind for a synthesized state-machine type (see
/// <c>~/roslyn-async.md</c> §5).
/// </summary>
public enum StateMachineContainerKind
{
    /// <summary>Emitted as a <c>struct</c>. Enables the no-alloc fast path
    /// when an awaited operation completes synchronously: the builder boxes
    /// the struct exactly once, on first suspension.</summary>
    Struct,

    /// <summary>Emitted as a <c>class</c>. Required for async-iterators
    /// (spec §10) and for any future Edit-and-Continue support.</summary>
    Class,
}
