// <copyright file="SuspendingKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// How a function came to be <em>suspending</em> (ADR-0174 D4): compiled as a
/// state machine returning `ValueTask[R]` with no observable task, and
/// awaited implicitly at every G# call site.
enum SuspendingKind {
    None,
    Inferred,
    Declared,
    Slot
}
