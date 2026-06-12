// <copyright file="SequenceExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;

namespace Gsharp.Extensions.Sequences;

/// <summary>
/// ADR-0084 / issue #724. G#-shaped extension methods on
/// <see cref="IEnumerable{T}"/> (the CLR projection of the G#
/// <c>sequence[T]</c> type clause). Splits into three groups:
/// <list type="bullet">
///   <item>Transformers: <see cref="Windowed{T}"/>,
///         <see cref="Chunked{T}"/>, <see cref="Indexed{T}"/>,
///         <see cref="Pairwise{T}"/>, <see cref="Interleave{T}"/>.</item>
///   <item>Safe terminals: <see cref="FirstValueOrNil{T}(IEnumerable{T})"/>,
///         <see cref="LastValueOrNil{T}(IEnumerable{T})"/>,
///         <see cref="SingleValueOrNil{T}(IEnumerable{T})"/> and their
///         reference-type-receiver companions
///         <see cref="FirstOrNil{T}"/> / <see cref="LastOrNil{T}"/> /
///         <see cref="SingleOrNil{T}"/>.</item>
///   <item>Collectors: <see cref="ToSlice{T}"/>,
///         <see cref="ToMap{TKey, TValue}"/>,
///         <see cref="ToMap{T, TKey, TValue}"/>.</item>
/// </list>
/// </summary>
/// <remarks>
/// Per ADR-0084 the safe terminals
/// (<see cref="FirstValueOrNil{T}"/>/<see cref="LastValueOrNil{T}"/>/<see cref="SingleValueOrNil{T}"/>
/// and their <c>Ref</c> peers) and <see cref="Indexed{T}"/> are
/// aggressive-inlined. Iterator-block transformers are not, because
/// their bodies are compiler-generated state machines the JIT cannot
/// inline anyway.
/// </remarks>
public static class SequenceExtensions
{
    /// <summary>
    /// Sliding window: emits every contiguous slice of size
    /// <paramref name="size"/>. Each yielded slice is a freshly
    /// allocated array — callers may keep references safely.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <param name="size">Window size. Must be positive.</param>
    /// <returns>The sliding-window sequence.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentOutOfRangeException">Thrown when
    /// <paramref name="size"/> is non-positive.</exception>
    public static IEnumerable<T[]> Windowed<T>(this IEnumerable<T> source, int size)
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        if (size <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(size), size, "size must be positive.");
        }

        return WindowedIterator(source, size);
    }

    /// <summary>
    /// Non-overlapping chunks: emits arrays of <paramref name="size"/>
    /// elements at a time; the last chunk may be shorter.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <param name="size">Chunk size. Must be positive.</param>
    /// <returns>The chunked sequence.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentOutOfRangeException">Thrown when
    /// <paramref name="size"/> is non-positive.</exception>
    public static IEnumerable<T[]> Chunked<T>(this IEnumerable<T> source, int size)
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        if (size <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(size), size, "size must be positive.");
        }

        return ChunkedIterator(source, size);
    }

    /// <summary>
    /// Pairs every element with its zero-based index. Emitted as a
    /// <c>(int32, T)</c> value tuple — the issue's spec spelling.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The indexed sequence.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static IEnumerable<(int Index, T Value)> Indexed<T>(this IEnumerable<T> source)
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        return IndexedIterator(source);
    }

    /// <summary>
    /// Emits adjacent pairs. A two-element source produces one pair;
    /// a one-element or empty source produces zero pairs.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The pairwise sequence.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    public static IEnumerable<(T First, T Second)> Pairwise<T>(this IEnumerable<T> source)
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        return PairwiseIterator(source);
    }

    /// <summary>
    /// Interleaves two sequences element-by-element. When one side
    /// runs out, the remainder of the other is appended verbatim —
    /// matching the issue's "G#-shaped" expectation that interleave
    /// is non-truncating.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="source">The first sequence.</param>
    /// <param name="other">The second sequence.</param>
    /// <returns>The interleaved sequence.</returns>
    /// <exception cref="ArgumentNullException">Thrown when either
    /// argument is <see langword="null"/>.</exception>
    public static IEnumerable<T> Interleave<T>(this IEnumerable<T> source, IEnumerable<T> other)
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        if (other is null)
        {
            throw new ArgumentNullException(nameof(other));
        }

        return InterleaveIterator(source, other);
    }

    /// <summary>
    /// Safe first-element terminal (value-type elements): returns the
    /// first element wrapped in <see cref="Nullable{T}"/>, or
    /// <see langword="null"/> when the sequence is empty.
    /// </summary>
    /// <typeparam name="T">Element type (value type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The first element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? FirstValueOrNil<T>(this IEnumerable<T> source)
        where T : struct
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        foreach (var item in source)
        {
            return item;
        }

        return default(T?);
    }

    /// <summary>
    /// Safe first-element terminal for reference-typed sequences.
    /// Returns the first element, or <see langword="null"/> when empty.
    /// </summary>
    /// <typeparam name="T">Element type (reference type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The first element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? FirstOrNil<T>(this IEnumerable<T> source)
        where T : class
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        foreach (var item in source)
        {
            return item;
        }

        return null;
    }

    /// <summary>
    /// Safe last-element terminal (value-type elements).
    /// </summary>
    /// <typeparam name="T">Element type (value type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The last element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? LastValueOrNil<T>(this IEnumerable<T> source)
        where T : struct
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        T? result = default(T?);
        foreach (var item in source)
        {
            result = item;
        }

        return result;
    }

    /// <summary>
    /// Safe last-element terminal for reference-typed sequences.
    /// </summary>
    /// <typeparam name="T">Element type (reference type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The last element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? LastOrNil<T>(this IEnumerable<T> source)
        where T : class
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        T? result = null;
        foreach (var item in source)
        {
            result = item;
        }

        return result;
    }

    /// <summary>
    /// Safe single-element terminal (value-type elements). Returns the
    /// lone element only when the sequence contains exactly one; empty
    /// and multi-element inputs both map to <see langword="null"/> by
    /// design. Callers that want the throwing shape should use the BCL
    /// <see cref="Enumerable.Single{T}(IEnumerable{T})"/>.
    /// </summary>
    /// <typeparam name="T">Element type (value type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The lone element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? SingleValueOrNil<T>(this IEnumerable<T> source)
        where T : struct
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        using var enumerator = source.GetEnumerator();
        if (!enumerator.MoveNext())
        {
            return default(T?);
        }

        var first = enumerator.Current;
        if (enumerator.MoveNext())
        {
            return default(T?);
        }

        return first;
    }

    /// <summary>
    /// Safe single-element terminal for reference-typed sequences.
    /// </summary>
    /// <typeparam name="T">Element type (reference type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The lone element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? SingleOrNil<T>(this IEnumerable<T> source)
        where T : class
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        using var enumerator = source.GetEnumerator();
        if (!enumerator.MoveNext())
        {
            return null;
        }

        var first = enumerator.Current;
        if (enumerator.MoveNext())
        {
            return null;
        }

        return first;
    }

    /// <summary>
    /// Collects the sequence into a freshly allocated <c>[]T</c>.
    /// Equivalent to <see cref="Enumerable.ToArray{T}"/> but named to
    /// read naturally from G# call sites that think in slices.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>A new array holding every element of the sequence.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    public static T[] ToSlice<T>(this IEnumerable<T> source)
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        return source.ToArray();
    }

    /// <summary>
    /// Collects a sequence of <c>(K, V)</c> tuples into a
    /// <c>map[K]V</c>. The tuple shape is the G# spelling
    /// <c>sequence[(K, V)]</c>; duplicate keys throw, matching
    /// <see cref="Enumerable.ToDictionary{T, K}(IEnumerable{T}, Func{T, K})"/>.
    /// </summary>
    /// <typeparam name="TKey">Key type.</typeparam>
    /// <typeparam name="TValue">Value type.</typeparam>
    /// <param name="source">Source sequence of key/value tuples.</param>
    /// <returns>A new <see cref="Dictionary{TKey, TValue}"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    public static Dictionary<TKey, TValue> ToMap<TKey, TValue>(this IEnumerable<(TKey Key, TValue Value)> source)
        where TKey : notnull
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        var map = new Dictionary<TKey, TValue>();
        foreach (var entry in source)
        {
            map.Add(entry.Key, entry.Value);
        }

        return map;
    }

    /// <summary>
    /// Collects an arbitrary sequence into a <c>map[K]V</c> using
    /// caller-supplied key and value selectors.
    /// </summary>
    /// <typeparam name="T">Element type.</typeparam>
    /// <typeparam name="TKey">Key type.</typeparam>
    /// <typeparam name="TValue">Value type.</typeparam>
    /// <param name="source">Source sequence.</param>
    /// <param name="keyFn">Key selector.</param>
    /// <param name="valueFn">Value selector.</param>
    /// <returns>A new <see cref="Dictionary{TKey, TValue}"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when any argument
    /// is <see langword="null"/>.</exception>
    public static Dictionary<TKey, TValue> ToMap<T, TKey, TValue>(this IEnumerable<T> source, Func<T, TKey> keyFn, Func<T, TValue> valueFn)
        where TKey : notnull
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        if (keyFn is null)
        {
            throw new ArgumentNullException(nameof(keyFn));
        }

        if (valueFn is null)
        {
            throw new ArgumentNullException(nameof(valueFn));
        }

        var map = new Dictionary<TKey, TValue>();
        foreach (var item in source)
        {
            map.Add(keyFn(item), valueFn(item));
        }

        return map;
    }

    private static IEnumerable<T[]> WindowedIterator<T>(IEnumerable<T> source, int size)
    {
        var buffer = new Queue<T>(size);
        foreach (var item in source)
        {
            buffer.Enqueue(item);
            if (buffer.Count == size)
            {
                yield return buffer.ToArray();
                buffer.Dequeue();
            }
        }
    }

    private static IEnumerable<T[]> ChunkedIterator<T>(IEnumerable<T> source, int size)
    {
        var buffer = new List<T>(size);
        foreach (var item in source)
        {
            buffer.Add(item);
            if (buffer.Count == size)
            {
                yield return buffer.ToArray();
                buffer.Clear();
            }
        }

        if (buffer.Count > 0)
        {
            yield return buffer.ToArray();
        }
    }

    private static IEnumerable<(int Index, T Value)> IndexedIterator<T>(IEnumerable<T> source)
    {
        var i = 0;
        foreach (var item in source)
        {
            yield return (i, item);
            i++;
        }
    }

    private static IEnumerable<(T First, T Second)> PairwiseIterator<T>(IEnumerable<T> source)
    {
        using var enumerator = source.GetEnumerator();
        if (!enumerator.MoveNext())
        {
            yield break;
        }

        var previous = enumerator.Current;
        while (enumerator.MoveNext())
        {
            var current = enumerator.Current;
            yield return (previous, current);
            previous = current;
        }
    }

    private static IEnumerable<T> InterleaveIterator<T>(IEnumerable<T> source, IEnumerable<T> other)
    {
        using var left = source.GetEnumerator();
        using var right = other.GetEnumerator();

        var leftAlive = left.MoveNext();
        var rightAlive = right.MoveNext();

        while (leftAlive && rightAlive)
        {
            yield return left.Current;
            yield return right.Current;
            leftAlive = left.MoveNext();
            rightAlive = right.MoveNext();
        }

        while (leftAlive)
        {
            yield return left.Current;
            leftAlive = left.MoveNext();
        }

        while (rightAlive)
        {
            yield return right.Current;
            rightAlive = right.MoveNext();
        }
    }
}
