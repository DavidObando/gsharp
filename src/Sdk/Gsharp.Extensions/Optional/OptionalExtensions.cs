// <copyright file="OptionalExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.CompilerServices;

namespace Gsharp.Extensions.Optional;

/// <summary>
/// ADR-0084 / issue #724. Reference-type-receiver overloads of the
/// <c>Gsharp.Extensions.Optional</c> helper surface. These extensions
/// reshape the BCL's plain-null reference shape into the G# nullable
/// idiom so call sites read like the issue's spec lines:
/// <code>
/// func [T, TResult] (self T?) Map(f (T) -&gt; TResult) TResult?
/// func [T, TResult] (self T?) FlatMap(f (T) -&gt; TResult?) TResult?
/// func [T]    (self T?) OrElse(default T) T
/// func [T]    (self T?) OrCompute(default () -&gt; T) T
/// func [T]    (self T?) OrThrow(message string) T
/// func [T]    (self T?) IfPresent(action (T) -&gt; void)
/// func [T]    (self T?) Filter(pred (T) -&gt; bool) T?
/// </code>
/// The struct-receiver overloads live in <see cref="OptionalValueExtensions"/>;
/// they are split into two static classes because C# cannot overload an
/// extension method by generic constraint alone, and the receiver type
/// (<c>Nullable&lt;T&gt;</c> for struct <c>T</c> vs. annotated <c>T</c> for
/// class <c>T</c>) is the only signature axis that lets the binder pick
/// the right overload at the call site.
/// </summary>
/// <remarks>
/// Per ADR-0084 the helpers marked here with
/// <see cref="MethodImplOptions.AggressiveInlining"/> are
/// <see cref="Map{T, TResult}(T, Func{T, TResult})"/>,
/// <see cref="FlatMap{T, TResult}(T, Func{T, TResult})"/>,
/// <see cref="OrElse{T}(T, T)"/>,
/// <see cref="OrCompute{T}(T, Func{T})"/>,
/// <see cref="Filter{T}(T, Func{T, bool})"/>, and
/// <see cref="IfPresent{T}(T, Action{T})"/>.
/// <see cref="OrThrow{T}(T, string)"/> stays out so the throw path
/// participates in the caller's stack trace and is not duplicated into
/// every consumer site.
/// </remarks>
public static class OptionalExtensions
{
    /// <summary>
    /// Reference-receiver <c>Map</c>: applies <paramref name="f"/> to a
    /// present value and returns its result, or returns <see langword="null"/>
    /// when <paramref name="self"/> is <see langword="null"/>.
    /// </summary>
    /// <typeparam name="T">Receiver element type. Constrained to a
    /// reference type — the value-type companion lives in
    /// <see cref="OptionalValueExtensions"/>.</typeparam>
    /// <typeparam name="TResult">Result element type. Constrained to a
    /// reference type so the projection's nullable shape round-trips
    /// faithfully.</typeparam>
    /// <param name="self">The nullable receiver (G# <c>T?</c>).</param>
    /// <param name="f">The projection. Not invoked when
    /// <paramref name="self"/> is <see langword="null"/>.</param>
    /// <returns><c>f(self)</c> when present; otherwise
    /// <see langword="null"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static TResult? Map<T, TResult>(this T? self, Func<T, TResult> f)
        where T : class
        where TResult : class
    {
        if (f is null)
        {
            throw new ArgumentNullException(nameof(f));
        }

        return self is null ? null : f(self);
    }

    /// <summary>
    /// Reference-receiver <c>FlatMap</c>: chains a projection that already
    /// produces an optional result, collapsing the two nullable layers
    /// into one.
    /// </summary>
    /// <typeparam name="T">Receiver element type (reference type).</typeparam>
    /// <typeparam name="TResult">Result element type (reference type).</typeparam>
    /// <param name="self">The nullable receiver (G# <c>T?</c>).</param>
    /// <param name="f">The optional-returning projection.</param>
    /// <returns><c>f(self)</c> when present; otherwise
    /// <see langword="null"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static TResult? FlatMap<T, TResult>(this T? self, Func<T, TResult?> f)
        where T : class
        where TResult : class
    {
        if (f is null)
        {
            throw new ArgumentNullException(nameof(f));
        }

        return self is null ? null : f(self);
    }

    /// <summary>
    /// Returns <paramref name="self"/> when present, otherwise
    /// <paramref name="defaultValue"/>. Mirrors the G# spelling
    /// <c>self ?: defaultValue</c> but kept as a named helper so it is
    /// usable as a method-group/lambda value.
    /// </summary>
    /// <typeparam name="T">Receiver element type (reference type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="defaultValue">The fallback returned when
    /// <paramref name="self"/> is <see langword="null"/>.</param>
    /// <returns><paramref name="self"/> if present; otherwise
    /// <paramref name="defaultValue"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T OrElse<T>(this T? self, T defaultValue)
        where T : class
    {
        return self ?? defaultValue;
    }

    /// <summary>
    /// Returns <paramref name="self"/> when present, otherwise invokes
    /// <paramref name="defaultFactory"/> exactly once and returns its result.
    /// </summary>
    /// <typeparam name="T">Receiver element type (reference type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="defaultFactory">Zero-arg factory whose result is the
    /// fallback. Not invoked when <paramref name="self"/> is present.</param>
    /// <returns><paramref name="self"/> if present; otherwise
    /// <c>defaultFactory()</c>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T OrCompute<T>(this T? self, Func<T> defaultFactory)
        where T : class
    {
        if (defaultFactory is null)
        {
            throw new ArgumentNullException(nameof(defaultFactory));
        }

        return self ?? defaultFactory();
    }

    /// <summary>
    /// Returns <paramref name="self"/> when present, otherwise throws an
    /// <see cref="InvalidOperationException"/> with the supplied message.
    /// Intentionally not aggressive-inlined (per ADR-0084) so the throw
    /// site stays in the caller's stack trace.
    /// </summary>
    /// <typeparam name="T">Receiver element type (reference type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="message">Exception message surfaced when
    /// <paramref name="self"/> is <see langword="null"/>.</param>
    /// <returns>The present value.</returns>
    /// <exception cref="InvalidOperationException">Thrown when
    /// <paramref name="self"/> is <see langword="null"/>.</exception>
    public static T OrThrow<T>(this T? self, string message)
        where T : class
    {
        if (self is null)
        {
            throw new InvalidOperationException(message);
        }

        return self;
    }

    /// <summary>
    /// Invokes <paramref name="action"/> with the present value, or does
    /// nothing when <paramref name="self"/> is <see langword="null"/>.
    /// </summary>
    /// <typeparam name="T">Receiver element type (reference type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="action">Side-effecting action invoked once on the
    /// present value.</param>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static void IfPresent<T>(this T? self, Action<T> action)
        where T : class
    {
        if (action is null)
        {
            throw new ArgumentNullException(nameof(action));
        }

        if (self is not null)
        {
            action(self);
        }
    }

    /// <summary>
    /// Returns <paramref name="self"/> when present and the predicate
    /// returns <see langword="true"/>; otherwise returns
    /// <see langword="null"/>.
    /// </summary>
    /// <typeparam name="T">Receiver element type (reference type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="predicate">Predicate evaluated on the present value.</param>
    /// <returns><paramref name="self"/> when present and the predicate
    /// holds; otherwise <see langword="null"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T? Filter<T>(this T? self, Func<T, bool> predicate)
        where T : class
    {
        if (predicate is null)
        {
            throw new ArgumentNullException(nameof(predicate));
        }

        if (self is null)
        {
            return null;
        }

        return predicate(self) ? self : null;
    }
}
