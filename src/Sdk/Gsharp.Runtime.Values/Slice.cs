// <copyright file="Slice.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Collections;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Gsharp.Values;

/// <summary>A copied descriptor over shared, GC-owned array storage.</summary>
/// <typeparam name="T">The invariant element type.</typeparam>
public readonly struct Slice<T> : IEquatable<Slice<T>>, IEnumerable<T>
{
    private readonly T[]? owner;
    private readonly int offset;

    private Slice(T[]? owner, int offset, int length, int capacity)
    {
        this.owner = owner;
        this.offset = offset;
        Length = length;
        Capacity = capacity;
    }

    /// <summary>Gets the number of visible elements.</summary>
    public int Length { get; }

    /// <summary>Gets the number of elements available for reslicing or append.</summary>
    public int Capacity { get; }

    /// <summary>Gets a value indicating whether the logical range is empty.</summary>
    public bool IsEmpty => Length == 0;

    private T[] Owner => owner ?? Array.Empty<T>();

    /// <summary>Gets a writable reference to a logical element.</summary>
    /// <param name="index">The zero-based logical index.</param>
    /// <returns>The backing element, not a copy.</returns>
    public ref T this[int index]
    {
        get
        {
            ValidateIndex(index);
            return ref Owner[offset + index];
        }
    }

    /// <summary>Gets a writable reference using a from-end index.</summary>
    /// <param name="index">The logical index.</param>
    /// <returns>The backing element.</returns>
    public ref T this[Index index] => ref this[index.GetOffset(Length)];

    /// <summary>Gets an element after validating a native from-end operand.</summary>
    /// <param name="index">The written nonnegative index operand.</param>
    /// <param name="fromEnd">Whether the operand is relative to Length.</param>
    /// <returns>The backing element.</returns>
    public ref T this[int index, bool fromEnd]
    {
        get
        {
            ValidateIndexOperand(index);
            return ref this[fromEnd ? Length - index : index];
        }
    }

    /// <summary>Compares descriptor identity, not contents.</summary>
    /// <param name="left">The left descriptor.</param>
    /// <param name="right">The right descriptor.</param>
    /// <returns>Whether the descriptors are identical.</returns>
    public static bool operator ==(Slice<T> left, Slice<T> right) => left.Equals(right);

    /// <summary>Compares descriptor identity, not contents.</summary>
    /// <param name="left">The left descriptor.</param>
    /// <param name="right">The right descriptor.</param>
    /// <returns>Whether the descriptors differ.</returns>
    public static bool operator !=(Slice<T> left, Slice<T> right) => !left.Equals(right);

    /// <summary>Creates CLR-default elements with independent length and capacity.</summary>
    /// <param name="length">The logical length.</param>
    /// <param name="capacity">The allocated capacity.</param>
    /// <returns>The new descriptor.</returns>
    public static Slice<T> Create(int length, int capacity)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(capacity);
        if ((uint)length > (uint)capacity)
        {
            throw new ArgumentOutOfRangeException(nameof(length));
        }

        return new Slice<T>(new T[capacity], 0, length, capacity);
    }

    /// <summary>Shares an entire exact-runtime-type array; covariant arrays are rejected.</summary>
    /// <param name="array">The non-null exact <typeparamref name="T"/> array.</param>
    /// <returns>A whole-array descriptor.</returns>
    public static Slice<T> FromArray(T[] array)
    {
        ArgumentNullException.ThrowIfNull(array);
        if (array.GetType() != typeof(T[]))
        {
            throw new ArrayTypeMismatchException();
        }

        return new Slice<T>(array, 0, array.Length, array.Length);
    }

    /// <summary>Recovers only exact-array-backed memory, without copying or widening its range.</summary>
    /// <param name="memory">The logical memory range.</param>
    /// <param name="result">The slice, or default on failure.</param>
    /// <returns>Whether the memory has an admitted array owner.</returns>
    public static bool TryFromMemory(Memory<T> memory, out Slice<T> result)
        => TryFromReadOnlyMemory(memory, out result);

    /// <summary>Returns a shared view with an exclusive upper endpoint.</summary>
    /// <param name="lo">The inclusive lower endpoint.</param>
    /// <param name="hi">The exclusive upper endpoint, measured from this descriptor.</param>
    /// <returns>A view retaining the remaining capacity.</returns>
    public Slice<T> Subslice(int lo, int hi) => Subslice(lo, hi, Capacity);

    /// <summary>Returns a view from a saved range, resolving from-end indices against Length.</summary>
    /// <param name="range">The exclusive-endpoint range.</param>
    /// <returns>The shared view.</returns>
    public Slice<T> Subslice(Range range) => Subslice(range.Start.GetOffset(Length), range.End.GetOffset(Length));

    /// <summary>Returns a shared view with an exclusive capacity endpoint.</summary>
    /// <param name="lo">The inclusive lower endpoint.</param>
    /// <param name="hi">The exclusive upper endpoint.</param>
    /// <param name="max">The exclusive capacity endpoint.</param>
    /// <returns>A capacity-limited view.</returns>
    public Slice<T> Subslice(int lo, int hi, int max)
    {
        if ((uint)max > (uint)Capacity)
        {
            throw new ArgumentOutOfRangeException(nameof(max));
        }

        if ((uint)hi > (uint)max)
        {
            throw new ArgumentOutOfRangeException(nameof(hi));
        }

        if ((uint)lo > (uint)hi)
        {
            throw new ArgumentOutOfRangeException(nameof(lo));
        }

        return new Slice<T>(owner, offset + lo, hi - lo, max - lo);
    }

    /// <summary>Normalizes native range bounds after all argument expressions have run.</summary>
    /// <param name="lo">The written lower bound.</param>
    /// <param name="hi">The written upper bound.</param>
    /// <param name="lowerFromEnd">Whether the lower bound is relative to Length.</param>
    /// <param name="upperFromEnd">Whether the upper bound is relative to Length.</param>
    /// <returns>A shared view using exclusive endpoints.</returns>
    public Slice<T> Subslice(int lo, int hi, bool lowerFromEnd, bool upperFromEnd)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(lo);
        ArgumentOutOfRangeException.ThrowIfNegative(hi);
        return Subslice(lowerFromEnd ? Length - lo : lo, upperFromEnd ? Length - hi : hi);
    }

    /// <summary>Returns a descriptor extended by one element, retaining old aliases on growth.</summary>
    /// <param name="value">The element to append.</param>
    /// <returns>The extended descriptor.</returns>
    public Slice<T> Append(T value)
    {
        var length = checked(Length + 1);
        var result = PrepareAppend(length);
        result.Owner[result.offset + Length] = value;
        return result;
    }

    /// <summary>Appends the source's logical range with overlap-safe copying.</summary>
    /// <param name="source">The saved source descriptor.</param>
    /// <returns>The extended descriptor.</returns>
    public Slice<T> AppendRange(Slice<T> source) => AppendRange(source.AsReadOnly());

    /// <summary>Appends the source's logical range with overlap-safe copying.</summary>
    /// <param name="source">The saved source descriptor.</param>
    /// <returns>The extended descriptor.</returns>
    public Slice<T> AppendRange(ReadOnlySlice<T> source)
    {
        var length = checked(Length + source.Length);
        var result = PrepareAppend(length);
        source.AsSpan().CopyTo(result.Owner.AsSpan(result.offset + Length, source.Length));
        return result;
    }

    /// <summary>Copies the shorter logical length, with memmove overlap semantics.</summary>
    /// <param name="destination">The destination's logical range.</param>
    /// <returns>The number of elements copied.</returns>
    public int CopyTo(Slice<T> destination) => AsReadOnly().CopyTo(destination);

    /// <summary>Clears only the logical range to CLR defaults.</summary>
    public void Clear() => AsSpan().Clear();

    /// <summary>Creates an independent shallow copy with capacity equal to length.</summary>
    /// <returns>The mutable independent descriptor.</returns>
    public Slice<T> Clone() => FromArray(ToArray());

    /// <summary>Copies the logical range to an independent exact-length array.</summary>
    /// <returns>The copied array.</returns>
    public T[] ToArray()
    {
        var result = new T[Length];
        AsSpan().CopyTo(result);
        return result;
    }

    /// <summary>Weakens permissions without copying elements.</summary>
    /// <returns>A readonly view of the same descriptor.</returns>
    public ReadOnlySlice<T> AsReadOnly() => new(this);

    /// <summary>Borrows a writable span of exactly the logical range.</summary>
    /// <returns>The shared span.</returns>
    public Span<T> AsSpan() => Owner.AsSpan(offset, Length);

    /// <summary>Shares exactly the logical range as memory.</summary>
    /// <returns>The shared memory.</returns>
    public Memory<T> AsMemory() => Owner.AsMemory(offset, Length);

    /// <summary>Exposes the owner only when this descriptor covers the whole array.</summary>
    /// <param name="result">The exact owner, or null on failure.</param>
    /// <returns>Whether offset is zero and Length, Capacity, and owner length agree.</returns>
    public bool TryGetArray([NotNullWhen(true)] out T[]? result)
    {
        if (offset == 0 && Length == Capacity && Capacity == Owner.Length)
        {
            result = Owner;
            return true;
        }

        result = null;
        return false;
    }

    /// <inheritdoc/>
    public bool Equals(Slice<T> other)
        => ReferenceEquals(Owner, other.Owner) && offset == other.offset
            && Length == other.Length && Capacity == other.Capacity;

    /// <inheritdoc/>
    public override bool Equals(object? obj) => obj is Slice<T> other && Equals(other);

    /// <inheritdoc/>
    public override int GetHashCode() => HashCode.Combine(RuntimeHelpers.GetHashCode(Owner), offset, Length, Capacity);

    /// <summary>Iterates a saved descriptor's length, loading each element when visited.</summary>
    /// <returns>An allocation-free value enumerator.</returns>
    public Enumerator GetEnumerator() => new(this);

    IEnumerator<T> IEnumerable<T>.GetEnumerator() => GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    internal static bool TryFromReadOnlyMemory(ReadOnlyMemory<T> memory, out Slice<T> result)
    {
        // TryGetArray normalizes empty non-array memory to Array.Empty<T>().
        // Reject those owners before that normalization loses their identity.
        if (MemoryMarshal.TryGetMemoryManager<T, MemoryManager<T>>(memory, out _)
            || (typeof(T) == typeof(char)
                && MemoryMarshal.TryGetString(Unsafe.As<ReadOnlyMemory<T>, ReadOnlyMemory<char>>(ref memory), out _, out _, out _)))
        {
            result = default;
            return false;
        }

        if (MemoryMarshal.TryGetArray(memory, out var segment)
            && segment.Array is { } array && array.GetType() == typeof(T[]))
        {
            result = new Slice<T>(array, segment.Offset, segment.Count, segment.Count);
            return true;
        }

        result = default;
        return false;
    }

    private void ValidateIndex(int index)
    {
        if ((uint)index >= (uint)Length)
        {
            throw new IndexOutOfRangeException();
        }
    }

    private static void ValidateIndexOperand(int index)
    {
        if (index < 0)
        {
            throw new IndexOutOfRangeException();
        }
    }

    private Slice<T> PrepareAppend(int length)
    {
        if (length <= Capacity)
        {
            return new Slice<T>(owner, offset, length, Capacity);
        }

        var capacity = (int)Math.Min(Array.MaxLength, Math.Max((long)length, Math.Max(4L, 2L * Capacity)));
        capacity = Math.Max(length, capacity);
        var result = new Slice<T>(new T[capacity], 0, length, capacity);
        AsSpan().CopyTo(result.AsSpan());
        return result;
    }

    /// <summary>A by-value iterator over a saved descriptor, without modification version checks.</summary>
    public struct Enumerator : IEnumerator<T>
    {
        private readonly Slice<T> slice;
        private int index;

        internal Enumerator(Slice<T> slice)
        {
            this.slice = slice;
            index = -1;
        }

        /// <inheritdoc/>
        public readonly T Current => slice[index];

        readonly object? IEnumerator.Current => Current;

        /// <inheritdoc/>
        public bool MoveNext()
        {
            if (index < slice.Length)
            {
                index++;
            }

            return index < slice.Length;
        }

        /// <inheritdoc/>
        public void Reset() => index = -1;

        /// <inheritdoc/>
        public readonly void Dispose()
        {
        }
    }
}
