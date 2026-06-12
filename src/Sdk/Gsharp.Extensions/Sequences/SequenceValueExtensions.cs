// <copyright file="SequenceValueExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace Gsharp.Extensions.Sequences;

/// <summary>
/// Value-typed (<c>T : struct</c>) safe-terminal overloads that share their
/// names with the reference-typed overloads on
/// <see cref="SequenceExtensions"/>. The methods live in a sibling class
/// because the C# language treats generic constraints as out-of-signature
/// for CS0111 purposes (two methods with identical parameter shapes
/// cannot coexist inside one class even with disjoint
/// <c>where T : class</c> / <c>where T : struct</c> constraints).
/// </summary>
/// <remarks>
/// The G# binder (ADR-0088 / issue #750) honours the generic constraints
/// and picks the right overload across both classes based on the element
/// type at the call site, so callers see one unified surface
/// (<c>FirstOrNil</c>, <c>LastOrNil</c>, <c>SingleOrNil</c>) regardless
/// of whether <c>T</c> is a reference or value type.
/// </remarks>
public static class SequenceValueExtensions
{
    /// <summary>
    /// Safe first-element terminal for value-typed sequences.
    /// Returns the first element wrapped in <see cref="Nullable{T}"/>, or
    /// <see langword="null"/> when the sequence is empty.
    /// </summary>
    /// <typeparam name="T">Element type (value type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The first element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? FirstOrNil<T>(this IEnumerable<T> source)
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
    /// Safe last-element terminal for value-typed sequences.
    /// </summary>
    /// <typeparam name="T">Element type (value type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The last element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? LastOrNil<T>(this IEnumerable<T> source)
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
    /// Safe single-element terminal for value-typed sequences. Returns the
    /// lone element only when the sequence contains exactly one; empty
    /// and multi-element inputs both map to <see langword="null"/> by
    /// design. Callers that want the throwing shape should use the BCL
    /// <see cref="System.Linq.Enumerable.Single{T}(IEnumerable{T})"/>.
    /// </summary>
    /// <typeparam name="T">Element type (value type).</typeparam>
    /// <param name="source">The source sequence.</param>
    /// <returns>The lone element or <see langword="null"/>.</returns>
    /// <exception cref="ArgumentNullException">Thrown when
    /// <paramref name="source"/> is <see langword="null"/>.</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? SingleOrNil<T>(this IEnumerable<T> source)
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
}
