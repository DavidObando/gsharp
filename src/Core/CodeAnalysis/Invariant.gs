// <copyright file="Invariant.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import System
import System.Runtime.CompilerServices

/// Asserts a nullability invariant the compiler cannot see, in place of the
/// null-forgiving operator.
/// @remarks ADR-0155 requires a comment beside every `!` naming the invariant that
/// makes it safe. That works where the invariant is local and easy to state
/// ("the enclosing `if` tested this"), and those sites should keep using
/// `!`. It works badly where the invariant is real but non-local — a
/// reflection result narrowed three frames up, or a value established by a
/// sibling constructor — because an honest comment is long and a short one is
/// the laundering the rule exists to prevent.
///
/// (cref:Required{T}) makes the invariant an artifact instead of a
/// comment: it is stated once, in code, and if it is ever violated the failure
/// names it. That turns a bare (cref:NullReferenceException) some frames
/// later into an (cref:InvalidOperationException) at the assertion, with
/// the offending expression and the reason — which the compiler driver surfaces
/// as a GS9998 internal error, matching how the rest of Core reports a broken
/// invariant.
internal shared class Invariant {
    /// Returns [`value`](paramref), asserting it is not null.
    /// @typeparam T The reference type being asserted.
    /// @param value The value whose non-nullness is being asserted.
    /// @param because Why the value cannot be null here, in the same terms a reviewer would
    /// want: name the thing that establishes it, not the fact that it holds.
    /// "A nested type always has a declaring type" — not "not null here".
    /// @param expression Supplied by the compiler; the source text of [`value`](paramref).
    /// @returns The non-null value.
    /// @exception InvalidOperationException The invariant did not hold. The message carries
    /// [`expression`](paramref) and [`because`](paramref).
    func Required[T class](
        value T?,
        because string,
        @CallerArgumentExpression("value") expression string? = nil
    ) T -> value ??
        throw InvalidOperationException(
        "Invariant violated: '$expression' was null. Expected non-null because $because."
    )
}
