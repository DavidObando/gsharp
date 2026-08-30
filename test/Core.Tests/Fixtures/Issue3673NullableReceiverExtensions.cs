// <copyright file="Issue3673NullableReceiverExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.Fixtures;

/// <summary>
/// Issue #3673 fixture: mirrors the shape of
/// <c>Gsharp.Extensions.Optional.OrThrow</c> — an imported generic extension
/// method whose only inference site for <c>T</c> is a <c>Nullable&lt;T&gt;</c>
/// <c>this</c> parameter, plus a sibling whose ordinary argument also mentions
/// <c>T</c>. Calling the former with instance syntax on a value-typed nullable
/// receiver must infer <c>T</c> from the receiver alone.
/// </summary>
public static class Issue3673NullableReceiverExtensions
{
    /// <summary>Unwraps a present value or throws; <c>T</c> is inferable only from the receiver.</summary>
    /// <typeparam name="T">The underlying value type.</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="message">The exception message used when the receiver has no value.</param>
    /// <returns>The receiver's value when present.</returns>
    public static T UnwrapOrThrow3673<T>(this T? self, string message)
        where T : struct
        => self ?? throw new System.InvalidOperationException(message);

    /// <summary>Unwraps a present reference or throws; <c>T</c> is inferable only from the receiver.</summary>
    /// <typeparam name="T">The underlying reference type.</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="message">The exception message used when the receiver is null.</param>
    /// <returns>The receiver's value when present.</returns>
    public static T UnwrapOrThrow3673<T>(this T self, string message)
        where T : class
        => self ?? throw new System.InvalidOperationException(message);

    /// <summary>Returns the receiver's value, or <paramref name="fallback"/>; <c>T</c> is also inferable from the argument.</summary>
    /// <typeparam name="T">The underlying value type.</typeparam>
    /// <param name="self">The nullable receiver.</param>
    /// <param name="fallback">The value returned when the receiver has no value.</param>
    /// <returns>The receiver's value when present, otherwise <paramref name="fallback"/>.</returns>
    public static T UnwrapOrElse3673<T>(this T? self, T fallback)
        where T : struct
        => self ?? fallback;

    /// <summary>Takes the underlying value type directly, so a nullable receiver must not match it.</summary>
    /// <param name="self">The receiver.</param>
    /// <returns>The receiver, doubled.</returns>
    public static int Double3673(this int self) => self * 2;
}
