// <copyright file="OptionalValueExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.CompilerServices;

namespace Gsharp.Extensions.Optional;

/// <summary>
/// ADR-0084 / issue #724. Value-type-receiver overloads of the
/// <c>Gsharp.Extensions.Optional</c> helper surface. Mirrors
/// <see cref="OptionalExtensions"/> with <c>where T : struct</c>
/// (and, for projecting helpers, <c>where TResult : struct</c>) so the
/// G# binder can resolve the right overload when the receiver is
/// a <c>Nullable&lt;T&gt;</c>.
/// </summary>
/// <remarks>
/// The split into two static classes is forced by C#'s overload
/// resolution: two extension methods with identical names and parameter
/// types cannot be distinguished by generic constraint alone. Splitting
/// the receiver type axis (<c>T?</c> with <c>T : struct</c> vs.
/// <c>T?</c> with <c>T : class</c>) places the constraint on the
/// receiver's CLR type, which the binder *can* see.
/// <para/>
/// The same <see cref="MethodImplOptions.AggressiveInlining"/> policy
/// from ADR-0084 applies here: every helper except <see cref="OrThrowValue{T}"/>
/// is annotated for inlining across the assembly boundary.
/// </remarks>
public static class OptionalValueExtensions
{
    /// <summary>
    /// Value-receiver <c>Map</c>: applies <paramref name="f"/> to a
    /// present value and wraps the result, or returns
    /// <see langword="null"/> when <paramref name="self"/> has no value.
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <typeparam name="TResult">Result element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="f">The projection.</param>
    /// <returns><c>f(self.Value)</c> wrapped in <see cref="Nullable{T}"/>
    /// when present; otherwise <see langword="null"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static TResult? MapValue<T, TResult>(this T? self, Func<T, TResult> f)
        where T : struct
        where TResult : struct
    {
        if (f is null)
        {
            throw new ArgumentNullException(nameof(f));
        }

        return self.HasValue ? f(self.Value) : default(TResult?);
    }

    /// <summary>
    /// Value-receiver <c>FlatMap</c>: chains an optional-returning
    /// projection.
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <typeparam name="TResult">Result element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="f">The optional-returning projection.</param>
    /// <returns><c>f(self.Value)</c> when present; otherwise
    /// <see langword="null"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static TResult? FlatMapValue<T, TResult>(this T? self, Func<T, TResult?> f)
        where T : struct
        where TResult : struct
    {
        if (f is null)
        {
            throw new ArgumentNullException(nameof(f));
        }

        return self.HasValue ? f(self.Value) : default(TResult?);
    }

    /// <summary>
    /// Returns the present value, otherwise <paramref name="defaultValue"/>.
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="defaultValue">Fallback.</param>
    /// <returns>The present value, or <paramref name="defaultValue"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T OrElseValue<T>(this T? self, T defaultValue)
        where T : struct
    {
        return self.HasValue ? self.Value : defaultValue;
    }

    /// <summary>
    /// Returns the present value, otherwise the result of
    /// <paramref name="defaultFactory"/> (invoked once on the absent path).
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="defaultFactory">Zero-arg factory invoked only when
    /// <paramref name="self"/> has no value.</param>
    /// <returns>The present value or <c>defaultFactory()</c>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T OrComputeValue<T>(this T? self, Func<T> defaultFactory)
        where T : struct
    {
        if (defaultFactory is null)
        {
            throw new ArgumentNullException(nameof(defaultFactory));
        }

        return self.HasValue ? self.Value : defaultFactory();
    }

    /// <summary>
    /// Returns the present value, otherwise throws an
    /// <see cref="InvalidOperationException"/> with the supplied
    /// <paramref name="message"/>. Not aggressive-inlined (ADR-0084).
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="message">Exception message used on the absent path.</param>
    /// <returns>The present value.</returns>
    /// <exception cref="InvalidOperationException">Thrown when
    /// <paramref name="self"/> has no value.</exception>
    public static T OrThrowValue<T>(this T? self, string message)
        where T : struct
    {
        if (!self.HasValue)
        {
            throw new InvalidOperationException(message);
        }

        return self.Value;
    }

    /// <summary>
    /// Invokes <paramref name="action"/> with the present value, or does
    /// nothing when <paramref name="self"/> has no value.
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="action">Side-effecting action invoked once on the
    /// present value.</param>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static void IfPresentValue<T>(this T? self, Action<T> action)
        where T : struct
    {
        if (action is null)
        {
            throw new ArgumentNullException(nameof(action));
        }

        if (self.HasValue)
        {
            action(self.Value);
        }
    }

    /// <summary>
    /// Returns <paramref name="self"/> when present and the predicate
    /// holds; otherwise <see langword="null"/>.
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="predicate">Predicate evaluated on the present value.</param>
    /// <returns><paramref name="self"/> when present and the predicate
    /// holds; otherwise <see langword="null"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? FilterValue<T>(this T? self, Func<T, bool> predicate)
        where T : struct
    {
        if (predicate is null)
        {
            throw new ArgumentNullException(nameof(predicate));
        }

        if (!self.HasValue)
        {
            return default(T?);
        }

        return predicate(self.Value) ? self : default(T?);
    }
}
