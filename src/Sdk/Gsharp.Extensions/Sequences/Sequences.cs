// <copyright file="Sequences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace Gsharp.Extensions.Sequences;

/// <summary>
/// ADR-0084 / issue #724. G#-shaped sequence builders. The companion
/// <see cref="SequenceExtensions"/> static class supplies the
/// receiver-shaped transformers, safe terminals, and collectors over
/// <see cref="IEnumerable{T}"/> (the CLR projection of the G#
/// <c>sequence[T]</c> type clause).
/// </summary>
/// <remarks>
/// Builders included here:
/// <list type="bullet">
///   <item><see cref="Range(int, int)"/> — <c>[start, start + count)</c>.</item>
///   <item><see cref="RangeStep(int, int, int)"/> — strided integer range.</item>
///   <item><see cref="Iterate{T}(T, Func{T, T})"/> — infinite <c>seed, f(seed), f(f(seed)), …</c>.</item>
///   <item><see cref="Repeat{T}(T)"/> — infinite <c>v, v, v, …</c>.</item>
///   <item><see cref="Of{T}(T[])"/> — inline literal sequence.</item>
///   <item><see cref="Empty{T}"/> — zero-allocation empty sequence.</item>
/// </list>
/// Per ADR-0084, the aggressive-inlined builders here are
/// <see cref="Of{T}(T[])"/> and <see cref="Empty{T}"/>; the iterator-block
/// helpers are not inlined because their compiler-generated state
/// machines are not meaningfully inlineable.
/// </remarks>
public static class Sequences
{
    /// <summary>
    /// Returns the empty sequence <c>[]</c>. Reuses
    /// <see cref="Array.Empty{T}"/> internally; no per-call allocation.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <returns>An empty <see cref="IEnumerable{T}"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static IEnumerable<T> Empty<T>()
    {
        return Array.Empty<T>();
    }

    /// <summary>
    /// Returns a sequence enumerating the supplied values in order.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="values">Inline arguments. May be empty.</param>
    /// <returns>The values as a sequence.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static IEnumerable<T> Of<T>(params T[] values)
    {
        return values ?? Array.Empty<T>();
    }

    /// <summary>
    /// Returns the half-open integer range
    /// <c>[start, start + count)</c>. Negative <paramref name="count"/>
    /// is rejected with <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    /// <param name="start">Start value (inclusive).</param>
    /// <param name="count">Number of values to emit.</param>
    /// <returns>The integer range.</returns>
    /// <exception cref="ArgumentOutOfRangeException">Thrown when
    /// <paramref name="count"/> is negative.</exception>
    public static IEnumerable<int> Range(int start, int count)
    {
        if (count < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(count), count, "count must be non-negative.");
        }

        return RangeIterator(start, count);
    }

    /// <summary>
    /// Returns the strided sequence
    /// <c>[start, start + step, start + 2*step, …]</c> stopping strictly
    /// before <paramref name="end"/> (ascending) or after
    /// <paramref name="end"/> (descending). A zero <paramref name="step"/>
    /// is rejected with <see cref="ArgumentException"/>.
    /// </summary>
    /// <param name="start">Start value (inclusive).</param>
    /// <param name="end">End value (exclusive).</param>
    /// <param name="step">Stride. Must be non-zero. May be negative
    /// when <paramref name="start"/> &gt; <paramref name="end"/>.</param>
    /// <returns>The strided range.</returns>
    /// <exception cref="ArgumentException">Thrown when
    /// <paramref name="step"/> is zero.</exception>
    public static IEnumerable<int> RangeStep(int start, int end, int step)
    {
        if (step == 0)
        {
            throw new ArgumentException("step must be non-zero.", nameof(step));
        }

        return RangeStepIterator(start, end, step);
    }

    /// <summary>
    /// Returns the infinite sequence
    /// <c>seed, next(seed), next(next(seed)), …</c>. Combine with
    /// <c>.Take(n)</c> from <c>System.Linq</c> to bound the iteration.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="seed">First emitted value.</param>
    /// <param name="next">Successor function. Must not be
    /// <see langword="null"/>.</param>
    /// <returns>The infinite sequence.</returns>
    public static IEnumerable<T> Iterate<T>(T seed, Func<T, T> next)
    {
        if (next is null)
        {
            throw new ArgumentNullException(nameof(next));
        }

        return IterateIterator(seed, next);
    }

    /// <summary>
    /// Returns the infinite sequence <c>value, value, value, …</c>.
    /// Combine with <c>.Take(n)</c> to bound.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="value">The value to repeat.</param>
    /// <returns>The infinite sequence.</returns>
    public static IEnumerable<T> Repeat<T>(T value)
    {
        return RepeatIterator(value);
    }

    private static IEnumerable<int> RangeIterator(int start, int count)
    {
        for (var i = 0; i < count; i++)
        {
            yield return start + i;
        }
    }

    private static IEnumerable<int> RangeStepIterator(int start, int end, int step)
    {
        if (step > 0)
        {
            for (var i = start; i < end; i += step)
            {
                yield return i;
            }
        }
        else
        {
            for (var i = start; i > end; i += step)
            {
                yield return i;
            }
        }
    }

    private static IEnumerable<T> IterateIterator<T>(T seed, Func<T, T> next)
    {
        var current = seed;
        while (true)
        {
            yield return current;
            current = next(current);
        }
    }

    private static IEnumerable<T> RepeatIterator<T>(T value)
    {
        while (true)
        {
            yield return value;
        }
    }
}
