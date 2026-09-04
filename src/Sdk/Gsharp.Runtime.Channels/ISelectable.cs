// <copyright file="ISelectable.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;

namespace Gsharp.Concurrency;

/// <summary>
/// Something a G# <c>select</c> receive arm can probe (ADR-0174 D1/D8):
/// channels constructed by G#, and the timer selectables <c>after</c> and
/// <c>tick</c>. The three-state encoding is normative: <c>(true, true)</c> a
/// value; <c>(true, false)</c> closed and drained, <c>value</c> is
/// the zero value; <c>(false, _)</c> nothing available right now.
/// </summary>
/// <typeparam name="T">The element type.</typeparam>
public interface ISelectable<T>
{
    /// <summary>Attempts a non-blocking receive.</summary>
    /// <param name="value">The delivered value, or the zero value.</param>
    /// <param name="ok">Whether a value was delivered; false with a true return means closed and drained.</param>
    /// <returns>True when the receive completed (with a value or with closed), false when it would have to park.</returns>
    bool TryReceive([MaybeNull] out T value, out bool ok);
}
