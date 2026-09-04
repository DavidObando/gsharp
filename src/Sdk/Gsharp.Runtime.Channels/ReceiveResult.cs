// <copyright file="ReceiveResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;

namespace Gsharp.Concurrency;

/// <summary>
/// The result of a channel receive (ADR-0174 D3): the value and whether the
/// receive delivered one. <c>(value, true)</c> is a delivered value;
/// <c>(default, false)</c> is "closed and drained". A readonly struct so the
/// fast path stays allocation-free; the suspending receive returns it in its
/// result rather than through an <c>out</c> parameter because a receive that
/// parks produces its value after the method returned.
/// </summary>
/// <typeparam name="T">The channel element type.</typeparam>
public readonly struct ReceiveResult<T>
{
    /// <summary>Initializes a new instance of the <see cref="ReceiveResult{T}"/> struct.</summary>
    /// <param name="value">The delivered value, or the element type's zero value when <paramref name="ok"/> is false.</param>
    /// <param name="ok">Whether a value was delivered.</param>
    public ReceiveResult([AllowNull] T value, bool ok)
    {
        // The parameter is [AllowNull] and Value is [MaybeNull]: both carry the
        // zero value when `ok` is false. The `!` only bridges the two attributes.
        Value = value!;
        Ok = ok;
    }

    /// <summary>Gets the "closed and drained" result: the zero value with <see cref="Ok"/> false.</summary>
    public static ReceiveResult<T> Closed => new(default, false);

    /// <summary>Gets the delivered value, or the element type's zero value when <see cref="Ok"/> is false.</summary>
    [MaybeNull]
    public T Value { get; }

    /// <summary>Gets a value indicating whether a value was delivered (false means closed and drained).</summary>
    public bool Ok { get; }

    /// <summary>Deconstructs into the Go-shaped <c>v, ok</c> pair.</summary>
    /// <param name="value">The delivered value.</param>
    /// <param name="ok">Whether a value was delivered.</param>
    public void Deconstruct([MaybeNull] out T value, out bool ok)
    {
        value = Value;
        ok = Ok;
    }
}
