// <copyright file="ReadOnlySlice.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections;

namespace Gsharp.Values;

/// <summary>A shared slice descriptor that grants only readonly element access.</summary>
/// <typeparam name="T">The invariant element type.</typeparam>
public readonly struct ReadOnlySlice<T> : IEquatable<ReadOnlySlice<T>>, IEnumerable<T>
{
    private readonly Slice<T> slice;

    internal ReadOnlySlice(Slice<T> slice) => this.slice = slice;

    /// <summary>Gets the logical length.</summary>
    public int Length => slice.Length;

    /// <summary>Gets the available reslicing capacity.</summary>
    public int Capacity => slice.Capacity;

    /// <summary>Gets a value indicating whether the logical range is empty.</summary>
    public bool IsEmpty => slice.IsEmpty;

    /// <summary>Gets a readonly reference to a logical element.</summary>
    /// <param name="index">The zero-based logical index.</param>
    /// <returns>The readonly backing element.</returns>
    public ref readonly T this[int index] => ref slice[index];

    /// <summary>Gets a readonly reference using a from-end index.</summary>
    /// <param name="index">The logical index.</param>
    /// <returns>The readonly backing element.</returns>
    public ref readonly T this[Index index] => ref slice[index];

    /// <summary>Gets an element after validating a native from-end operand.</summary>
    /// <param name="index">The written nonnegative index operand.</param>
    /// <param name="fromEnd">Whether it is relative to Length.</param>
    /// <returns>The readonly backing element.</returns>
    public ref readonly T this[int index, bool fromEnd] => ref slice[index, fromEnd];

    /// <summary>Weakens permissions without copying elements.</summary>
    /// <param name="value">The mutable descriptor.</param>
    public static implicit operator ReadOnlySlice<T>(Slice<T> value) => value.AsReadOnly();

    /// <summary>Compares descriptor identity, not contents.</summary>
    /// <param name="left">The left descriptor.</param>
    /// <param name="right">The right descriptor.</param>
    /// <returns>Whether the descriptors are identical.</returns>
    public static bool operator ==(ReadOnlySlice<T> left, ReadOnlySlice<T> right) => left.Equals(right);

    /// <summary>Compares descriptor identity, not contents.</summary>
    /// <param name="left">The left descriptor.</param>
    /// <param name="right">The right descriptor.</param>
    /// <returns>Whether the descriptors differ.</returns>
    public static bool operator !=(ReadOnlySlice<T> left, ReadOnlySlice<T> right) => !left.Equals(right);

    /// <summary>Shares a non-null exact array after rejecting covariance.</summary>
    /// <param name="array">The exact array.</param>
    /// <returns>The readonly whole-array descriptor.</returns>
    public static ReadOnlySlice<T> FromArray(T[] array) => Slice<T>.FromArray(array).AsReadOnly();

    /// <summary>Recovers only exact-array-backed readonly memory without copying.</summary>
    /// <param name="memory">The logical range.</param>
    /// <param name="result">The recovered descriptor, or default on failure.</param>
    /// <returns>Whether the owner is admitted.</returns>
    public static bool TryFromMemory(ReadOnlyMemory<T> memory, out ReadOnlySlice<T> result)
    {
        var success = Slice<T>.TryFromReadOnlyMemory(memory, out var recovered);
        result = recovered.AsReadOnly();
        return success;
    }

    /// <summary>Returns a shared view using exclusive endpoints.</summary>
    /// <param name="lo">The inclusive lower endpoint.</param>
    /// <param name="hi">The exclusive upper endpoint.</param>
    /// <returns>The readonly view.</returns>
    public ReadOnlySlice<T> Subslice(int lo, int hi) => slice.Subslice(lo, hi).AsReadOnly();

    /// <summary>Returns a shared view from a saved exclusive-endpoint range.</summary>
    /// <param name="range">The saved range.</param>
    /// <returns>The readonly view.</returns>
    public ReadOnlySlice<T> Subslice(Range range) => slice.Subslice(range).AsReadOnly();

    /// <summary>Returns a capacity-limited shared view.</summary>
    /// <param name="lo">The inclusive lower endpoint.</param>
    /// <param name="hi">The exclusive upper endpoint.</param>
    /// <param name="max">The exclusive capacity endpoint.</param>
    /// <returns>The readonly view.</returns>
    public ReadOnlySlice<T> Subslice(int lo, int hi, int max) => slice.Subslice(lo, hi, max).AsReadOnly();

    /// <summary>Normalizes native bounds after argument evaluation.</summary>
    /// <param name="lo">The written lower bound.</param>
    /// <param name="hi">The written upper bound.</param>
    /// <param name="lowerFromEnd">Whether the lower bound is relative to Length.</param>
    /// <param name="upperFromEnd">Whether the upper bound is relative to Length.</param>
    /// <returns>The readonly view.</returns>
    public ReadOnlySlice<T> Subslice(int lo, int hi, bool lowerFromEnd, bool upperFromEnd)
        => slice.Subslice(lo, hi, lowerFromEnd, upperFromEnd).AsReadOnly();

    /// <summary>Copies the shorter logical length using overlap-safe copying.</summary>
    /// <param name="destination">The writable destination.</param>
    /// <returns>The number of elements copied.</returns>
    public int CopyTo(Slice<T> destination)
    {
        var count = Math.Min(Length, destination.Length);
        AsSpan()[..count].CopyTo(destination.AsSpan());
        return count;
    }

    /// <summary>Creates an independent mutable shallow copy.</summary>
    /// <returns>The new descriptor with capacity equal to length.</returns>
    public Slice<T> Clone() => slice.Clone();

    /// <summary>Copies the logical range to an independent array.</summary>
    /// <returns>The copied array.</returns>
    public T[] ToArray() => slice.ToArray();

    /// <summary>Borrows readonly access to exactly the logical range.</summary>
    /// <returns>The shared readonly span.</returns>
    public ReadOnlySpan<T> AsSpan() => slice.AsSpan();

    /// <summary>Shares readonly access to exactly the logical range.</summary>
    /// <returns>The shared readonly memory.</returns>
    public ReadOnlyMemory<T> AsMemory() => slice.AsMemory();

    /// <inheritdoc/>
    public bool Equals(ReadOnlySlice<T> other) => slice.Equals(other.slice);

    /// <inheritdoc/>
    public override bool Equals(object? obj) => obj is ReadOnlySlice<T> other && Equals(other);

    /// <inheritdoc/>
    public override int GetHashCode() => slice.GetHashCode();

    /// <summary>Iterates saved Length, loading each element by value when visited.</summary>
    /// <returns>An allocation-free value enumerator.</returns>
    public Slice<T>.Enumerator GetEnumerator() => slice.GetEnumerator();

    IEnumerator<T> IEnumerable<T>.GetEnumerator() => GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
