// <copyright file="AsyncMethodSteppingInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Immutable

/// ADR-0174 P3-8: the IL offsets a debugger needs to step through an async or
/// suspending state machine's `MoveNext` — the Portable PDB
/// "Async Method Stepping Information" blob (kind
/// `54FD2AC5-E925-401A-9C2A-F94F171072F8`). Each await contributes the
/// offset where the method yields (the hidden marker before the state save
/// and `AwaitUnsafeOnCompleted`) and the offset where it resumes (the
/// hidden marker after the resume dispatch); the catch handler offset is the
/// start of the outermost `catch` that routes a fault to the builder,
/// or `-1` when there is none.
/// @param CatchHandlerOffset IL offset of the outermost catch handler, or `-1`.
/// @param Awaits One `(yield, resume)` offset pair per await, in state order.
internal data class AsyncMethodSteppingInfo(
    CatchHandlerOffset int32,
    Awaits ImmutableArray[(Yield int32, Resume int32)]
) : IEquatable[AsyncMethodSteppingInfo] { }
