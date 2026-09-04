// <copyright file="Chan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// Static factories for the G#-owned channel type (ADR-0174 D1/D12). The
/// generic <see cref="Chan{T}"/> is constructed from G# by the type clause
/// applied to arguments, <c>chan[T]()</c> / <c>chan[T](n)</c>; this
/// non-generic host carries the one factory that has no such spelling.
/// </summary>
public static class Chan
{
    /// <summary>
    /// Creates an unbounded channel — the wave-1 behavior of <c>make(chan T)</c>,
    /// now named. Deliberately the wordiest construction form: an unbounded
    /// buffer is a memory-leak risk Go does not even offer, and code that
    /// genuinely wants it should have to say so.
    /// </summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <returns>A new unbounded channel.</returns>
    public static Chan<T> Unbounded<T>() => Chan<T>.CreateUnbounded();
}
