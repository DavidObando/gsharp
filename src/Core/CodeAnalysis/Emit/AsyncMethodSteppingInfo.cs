// <copyright file="AsyncMethodSteppingInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 P3-8: the IL offsets a debugger needs to step through an async or
/// suspending state machine's <c>MoveNext</c> — the Portable PDB
/// "Async Method Stepping Information" blob (kind
/// <c>54FD2AC5-E925-401A-9C2A-F94F171072F8</c>). Each await contributes the
/// offset where the method yields (the hidden marker before the state save
/// and <c>AwaitUnsafeOnCompleted</c>) and the offset where it resumes (the
/// hidden marker after the resume dispatch); the catch handler offset is the
/// start of the outermost <c>catch</c> that routes a fault to the builder,
/// or <c>-1</c> when there is none.
/// </summary>
/// <param name="CatchHandlerOffset">IL offset of the outermost catch handler, or <c>-1</c>.</param>
/// <param name="Awaits">One <c>(yield, resume)</c> offset pair per await, in state order.</param>
internal sealed record AsyncMethodSteppingInfo(int CatchHandlerOffset, ImmutableArray<(int Yield, int Resume)> Awaits);
