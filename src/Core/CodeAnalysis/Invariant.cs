// <copyright file="Invariant.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.CompilerServices;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Asserts a nullability invariant the compiler cannot see, in place of the
/// null-forgiving operator.
/// </summary>
/// <remarks>
/// <para>
/// ADR-0155 requires a comment beside every <c>!</c> naming the invariant that
/// makes it safe. That works where the invariant is local and easy to state
/// ("the enclosing <c>if</c> tested this"), and those sites should keep using
/// <c>!</c>. It works badly where the invariant is real but non-local — a
/// reflection result narrowed three frames up, or a value established by a
/// sibling constructor — because an honest comment is long and a short one is
/// the laundering the rule exists to prevent.
/// </para>
/// <para>
/// <see cref="Required{T}"/> makes the invariant an artifact instead of a
/// comment: it is stated once, in code, and if it is ever violated the failure
/// names it. That turns a bare <see cref="NullReferenceException"/> some frames
/// later into an <see cref="InvalidOperationException"/> at the assertion, with
/// the offending expression and the reason — which the compiler driver surfaces
/// as a GS9998 internal error, matching how the rest of Core reports a broken
/// invariant.
/// </para>
/// </remarks>
internal static class Invariant
{
    /// <summary>
    /// Returns <paramref name="value"/>, asserting it is not null.
    /// </summary>
    /// <typeparam name="T">The reference type being asserted.</typeparam>
    /// <param name="value">The value whose non-nullness is being asserted.</param>
    /// <param name="because">
    /// Why the value cannot be null here, in the same terms a reviewer would
    /// want: name the thing that establishes it, not the fact that it holds.
    /// "A nested type always has a declaring type" — not "not null here".
    /// </param>
    /// <param name="expression">
    /// Supplied by the compiler; the source text of <paramref name="value"/>.
    /// </param>
    /// <returns>The non-null value.</returns>
    /// <exception cref="InvalidOperationException">
    /// The invariant did not hold. The message carries
    /// <paramref name="expression"/> and <paramref name="because"/>.
    /// </exception>
    public static T Required<T>(
        T? value,
        string because,
        [CallerArgumentExpression(nameof(value))] string? expression = null)
        where T : class
        => value ?? throw new InvalidOperationException(
            $"Invariant violated: '{expression}' was null. Expected non-null because {because}.");
}
