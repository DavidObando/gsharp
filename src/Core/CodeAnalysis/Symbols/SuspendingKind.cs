// <copyright file="SuspendingKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// How a function came to be <em>suspending</em> (ADR-0174 D4): compiled as a
/// state machine returning <c>ValueTask[R]</c> with no observable task, and
/// awaited implicitly at every G# call site.
/// </summary>
public enum SuspendingKind
{
    /// <summary>Not suspending: an ordinary function (or an <c>async func</c>, whose task is observable).</summary>
    None,

    /// <summary>Suspending by inference — the body performs a suspension point, directly or through a call (Phase 3-3).</summary>
    Inferred,

    /// <summary>Suspending by declaration: <c>suspend func</c>.</summary>
    Declared,

    /// <summary>Suspending because it overrides or implements a suspending declaration; the slot's ABI is fixed by the declaration.</summary>
    Slot,
}
