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
    [AllowNull]
    private readonly T value;

    /// <summary>Initializes a new instance of the <see cref="ReceiveResult{T}"/> struct.</summary>
    /// <param name="value">The delivered value, or the element type's zero value when <paramref name="ok"/> is false.</param>
    /// <param name="ok">Whether a value was delivered.</param>
    public ReceiveResult([AllowNull] T value, bool ok)
    {
        this.value = value;
        Ok = ok;
    }

    /// <summary>Gets the "closed and drained" result: the zero value with <see cref="Ok"/> false.</summary>
    public static ReceiveResult<T> Closed => new(default, false);

    /// <summary>Gets the delivered value, or the element type's zero value when <see cref="Ok"/> is false.</summary>
    [MaybeNull]
    public T Value => value;

    /// <summary>Gets a value indicating whether a value was delivered (false means closed and drained).</summary>
    public bool Ok { get; }

    /// <summary>
    /// Gets the element as a plain <typeparamref name="T"/> for the runtime's own forwarding into <c>T</c> slots
    /// (a <see cref="System.Threading.Tasks.ValueTask{TResult}"/>, a tuple, a buffer element).
    /// </summary>
    /// <remarks>
    /// Issue #4681: forwarding the public <see cref="Value"/> needed a <c>!</c>, which cs2gs carries into the
    /// migrated runtime as a fail-fast <c>!!</c> that throws on a <c>nil</c> element. The zero value of an
    /// unconstrained <c>T</c> is legitimately <c>null</c>, as in <c>List&lt;T&gt;</c>'s indexer, so this internal
    /// view drops the <c>MaybeNull</c> promise while the public property keeps it.
    /// </remarks>
    internal T Element => value;

    /// <summary>Deconstructs into the Go-shaped <c>v, ok</c> pair.</summary>
    /// <param name="value">The delivered value.</param>
    /// <param name="ok">Whether a value was delivered.</param>
    public void Deconstruct([MaybeNull] out T value, out bool ok)
    {
        value = this.value;
        ok = Ok;
    }

    /// <summary>Returns the zero value of <typeparamref name="T"/> as a plain <typeparamref name="T"/>, with no null-forgiving operator (a bare <c>default</c> would warn for an unconstrained <typeparamref name="T"/>).</summary>
    /// <returns>The zero value, which is <c>null</c> for a reference type.</returns>
    internal static T ZeroValue() => default(ReceiveResult<T>).Element;
}
