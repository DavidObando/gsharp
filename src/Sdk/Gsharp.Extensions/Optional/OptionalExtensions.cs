// <copyright file="OptionalExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.CompilerServices;

namespace Gsharp.Extensions.Optional;

/// <summary>
/// ADR-0084 / issue #724. The G#-shaped <c>Optional</c> helper surface,
/// single-named for both reference-typed and value-typed receivers. The
/// reference and struct receivers are disambiguated by the G# binder's
/// constraint-aware overload resolution (ADR-0088 / issue #750): two
/// overloads with the same name are kept because their CLR receiver
/// shapes differ (<c>T</c> with <c>where T : class</c> vs.
/// <c>Nullable&lt;T&gt;</c> with <c>where T : struct</c>) and the binder
/// honors the constraint clauses when picking between them.
/// </summary>
/// <remarks>
/// Prior to ADR-0088 the value-typed helpers carried a <c>*Value</c>
/// suffix (ADR-0084 §"Known limitations" L1). The suffix is gone now
/// that the binder enforces constraints during candidate filtering, so
/// every helper is reachable through the same call-site spelling
/// regardless of whether the receiver is a reference or a value type.
/// <para/>
/// Per ADR-0084 every helper marked here with
/// <see cref="MethodImplOptions.AggressiveInlining"/> stays
/// aggressive-inlined. <see cref="OrThrow{T}(T, string)"/> and the
/// struct companion stay out of the inlining set so the throw site
/// participates in the caller's stack trace.
/// </remarks>
public static class OptionalExtensions
{
    /// <summary>
    /// Reference-receiver <c>Map</c>: applies <paramref name="f"/> to a
    /// present value and returns its result, or returns <see langword="null"/>
    /// when <paramref name="self"/> is <see langword="null"/>.
    /// </summary>
    /// <typeparam name="T">Receiver element type (reference type).</typeparam>
    /// <typeparam name="TResult">Result element type (reference type).</typeparam>
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
    public static TResult? Map<T, TResult>(this T? self, Func<T, TResult> f)
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
    public static TResult? FlatMap<T, TResult>(this T? self, Func<T, TResult?> f)
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
    /// Returns the present value, otherwise <paramref name="defaultValue"/>.
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="defaultValue">Fallback.</param>
    /// <returns>The present value, or <paramref name="defaultValue"/>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T OrElse<T>(this T? self, T defaultValue)
        where T : struct
    {
        return self.HasValue ? self.Value : defaultValue;
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
    /// Returns the present value, otherwise the result of
    /// <paramref name="defaultFactory"/> (invoked once on the absent path).
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="defaultFactory">Zero-arg factory invoked only when
    /// <paramref name="self"/> has no value.</param>
    /// <returns>The present value or <c>defaultFactory()</c>.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T OrCompute<T>(this T? self, Func<T> defaultFactory)
        where T : struct
    {
        if (defaultFactory is null)
        {
            throw new ArgumentNullException(nameof(defaultFactory));
        }

        return self.HasValue ? self.Value : defaultFactory();
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
    public static T OrThrow<T>(this T? self, string message)
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
    /// Invokes <paramref name="action"/> with the present value, or does
    /// nothing when <paramref name="self"/> has no value.
    /// </summary>
    /// <typeparam name="T">Receiver element type (value type).</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="action">Side-effecting action invoked once on the
    /// present value.</param>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static void IfPresent<T>(this T? self, Action<T> action)
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
    public static T? Filter<T>(this T? self, Func<T, bool> predicate)
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
