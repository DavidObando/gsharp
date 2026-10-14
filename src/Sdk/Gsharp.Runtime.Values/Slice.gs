// <copyright file="Slice.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

import System
import System.Buffers
import System.Collections
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.Runtime.CompilerServices
import System.Runtime.InteropServices

/// A copied descriptor over shared, GC-owned array storage.
/// @typeparam T The invariant element type.
struct Slice[T] : IEquatable[Slice[T]], IEnumerable[T] {
    private let owner[]?T
    private let offset int32

    private init(owner[]?T, offset int32, length int32, capacity int32) {
        this.owner = owner
        this.offset = offset
        Length = length
        Capacity = capacity
    }

    /// Gets the number of visible elements.
    prop Length int32 {
        get;
    }

    /// Gets the number of elements available for reslicing or append.
    prop Capacity int32 {
        get;
    }

    /// Gets a value indicating whether the logical range is empty.
    prop IsEmpty bool -> Length == 0

    private prop Owner[]T -> owner ?? Array.Empty[T]()

    /// Gets a writable reference to a logical element.
    /// @param index The zero-based logical index.
    /// @returns The backing element, not a copy.
    prop this[index int32]ref T {
        get {
            ValidateIndex(index)
            return ref Owner[offset + index]
        }
    }

    /// Gets a writable reference using a from-end index.
    /// @param index The logical index.
    /// @returns The backing element.
    prop this[index Index]ref T -> this[index.GetOffset(Length)]

    /// Gets an element after validating a native from-end operand.
    /// @param index The written nonnegative index operand.
    /// @param fromEnd Whether the operand is relative to Length.
    /// @returns The backing element.
    prop this[index int32, fromEnd bool]ref T {
        get {
            ValidateIndexOperand(index)
            return ref this[
                if fromEnd {
                    Length - index
                } else {
                    index
                }
            ]
        }
    }

    /// Retains a selected backing element without exposing the backing owner.
    /// @param index The logical element index.
    /// @returns A persistent writable location.
    func GetManagedReference(index int32) ManagedRef[T] {
        ValidateIndex(index)
        return ManagedRef[T].FromArray(Owner, offset + index)
    }

    /// Retains a logical element selected by a from-end index.
    /// @param index The logical index.
    /// @returns A persistent writable location.
    func GetManagedReference(index Index) ManagedRef[T] -> GetManagedReference(index.GetOffset(Length))

    /// Retains a native-syntax element after checking its operand.
    /// @param index The written nonnegative operand.
    /// @param fromEnd Whether the operand is relative to Length.
    /// @returns A persistent writable location.
    func GetManagedReference(index int32, fromEnd bool) ManagedRef[T] {
        ValidateIndexOperand(index)
        return GetManagedReference(
            if fromEnd {
                Length - index
            } else {
                index
            }
        )
    }

    /// Retains a selected element with only readonly permission.
    /// @param index The logical element index.
    /// @returns A persistent readonly location.
    func GetReadOnlyManagedReference(index int32) ReadOnlyManagedRef[T] {
        ValidateIndex(index)
        return ReadOnlyManagedRef[T].FromArray(Owner, offset + index)
    }

    /// Retains a readonly element using a from-end index.
    /// @param index The logical index.
    /// @returns A persistent readonly location.
    func GetReadOnlyManagedReference(index Index) ReadOnlyManagedRef[T] -> GetReadOnlyManagedReference(
        index.GetOffset(Length)
    )

    /// Retains a native-syntax readonly element after checking its operand.
    /// @param index The written nonnegative operand.
    /// @param fromEnd Whether the operand is relative to Length.
    /// @returns A persistent readonly location.
    func GetReadOnlyManagedReference(index int32, fromEnd bool) ReadOnlyManagedRef[T] {
        ValidateIndexOperand(index)
        return GetReadOnlyManagedReference(
            if fromEnd {
                Length - index
            } else {
                index
            }
        )
    }

    /// Returns a shared view with an exclusive upper endpoint.
    /// @param lo The inclusive lower endpoint.
    /// @param hi The exclusive upper endpoint, measured from this descriptor.
    /// @returns A view retaining the remaining capacity.
    func Subslice(lo int32, hi int32) Slice[T] -> Subslice(lo, hi, Capacity)

    /// Returns a view from a saved range, resolving from-end indices against Length.
    /// @param range The exclusive-endpoint range.
    /// @returns The shared view.
    func Subslice($range Range) Slice[T] -> Subslice($range.Start.GetOffset(Length), $range.End.GetOffset(Length))

    /// Returns a shared view with an exclusive capacity endpoint.
    /// @param lo The inclusive lower endpoint.
    /// @param hi The exclusive upper endpoint.
    /// @param max The exclusive capacity endpoint.
    /// @returns A capacity-limited view.
    func Subslice(lo int32, hi int32, max int32) Slice[T] {
        if uint32(max) > uint32(Capacity) {
            throw ArgumentOutOfRangeException("max")
        }
        if uint32(hi) > uint32(max) {
            throw ArgumentOutOfRangeException("hi")
        }
        if uint32(lo) > uint32(hi) {
            throw ArgumentOutOfRangeException("lo")
        }
        return Slice[T](owner, offset + lo, hi - lo, max - lo)
    }

    /// Normalizes native range bounds after all argument expressions have run.
    /// @param lo The written lower bound.
    /// @param hi The written upper bound.
    /// @param lowerFromEnd Whether the lower bound is relative to Length.
    /// @param upperFromEnd Whether the upper bound is relative to Length.
    /// @returns A shared view using exclusive endpoints.
    func Subslice(lo int32, hi int32, lowerFromEnd bool, upperFromEnd bool) Slice[T] {
        ArgumentOutOfRangeException.ThrowIfNegative(lo, paramName: "lo")
        ArgumentOutOfRangeException.ThrowIfNegative(hi, paramName: "hi")
        return Subslice(
            if lowerFromEnd {
                Length - lo
            } else {
                lo
            },
            if upperFromEnd {
                Length - hi
            } else {
                hi
            }
        )
    }

    /// Returns a descriptor extended by one element, retaining old aliases on growth.
    /// @param value The element to append.
    /// @returns The extended descriptor.
    func Append(value T) Slice[T] {
        let length = checked(Length + 1)
        let result = PrepareAppend(length)
        result.Owner[result.offset + Length] = value
        return result
    }

    /// Appends the source's logical range with overlap-safe copying.
    /// @param source The saved source descriptor.
    /// @returns The extended descriptor.
    func AppendRange(source Slice[T]) Slice[T] -> AppendRange(source.AsReadOnly())

    /// Appends the source's logical range with overlap-safe copying.
    /// @param source The saved source descriptor.
    /// @returns The extended descriptor.
    func AppendRange(source ReadOnlySlice[T]) Slice[T] {
        let length = checked(Length + source.Length)
        let result = PrepareAppend(length)
        source.AsSpan().CopyTo(result.Owner.AsSpan(result.offset + Length, source.Length))
        return result
    }

    /// Copies the shorter logical length, with memmove overlap semantics.
    /// @param destination The destination's logical range.
    /// @returns The number of elements copied.
    func CopyTo(destination Slice[T]) int32 -> AsReadOnly().CopyTo(destination)

    /// Clears only the logical range to CLR defaults.
    func Clear() -> AsSpan().Clear()

    /// Creates an independent shallow copy with capacity equal to length.
    /// @returns The mutable independent descriptor.
    func Clone() Slice[T] -> FromArray(ToArray())

    /// Copies the logical range to an independent exact-length array.
    /// @returns The copied array.
    func ToArray()[]T {
        let result = [Length]T
        AsSpan().CopyTo(result)
        return result
    }

    /// Weakens permissions without copying elements.
    /// @returns A readonly view of the same descriptor.
    func AsReadOnly() ReadOnlySlice[T] -> ReadOnlySlice[T](this)

    /// Borrows a writable span of exactly the logical range.
    /// @returns The shared span.
    func AsSpan() Span[T] -> Owner.AsSpan(offset, Length)

    /// Shares exactly the logical range as memory.
    /// @returns The shared memory.
    func AsMemory() Memory[T] -> Owner.AsMemory(offset, Length)

    /// Exposes the owner only when this descriptor covers the whole array.
    /// @param result The exact owner, or null on failure.
    /// @returns Whether offset is zero and Length, Capacity, and owner length agree.
    func TryGetArray(@NotNullWhen(true) out result[]?T) bool {
        if offset == 0 && Length == Capacity && Capacity == Owner.Length {
            result = Owner
            return true
        }
        result = nil
        return false
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Equals(other Slice[T]) bool -> object.ReferenceEquals(Owner, other.Owner) &&
        offset == other.offset &&
        Length == other.Length &&
        Capacity == other.Capacity

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Equals(obj object?) bool -> obj is Slice[T]other && Equals(other)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetHashCode() int32 -> HashCode.Combine(RuntimeHelpers.GetHashCode(Owner), offset, Length, Capacity)

    /// Iterates a saved descriptor's length, loading each element when visited.
    /// @returns An allocation-free value enumerator.
    func GetEnumerator() Enumerator -> Enumerator(this)

    private func (IEnumerable[T]) GetEnumerator() IEnumerator[T] -> GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()

    private func ValidateIndex(index int32) {
        if uint32(index) >= uint32(Length) {
            throw IndexOutOfRangeException()
        }
    }

    private func PrepareAppend(length int32) Slice[T] {
        if length <= Capacity {
            return Slice[T](owner, offset, length, Capacity)
        }
        var capacity = int32(Math.Min(Array.MaxLength, Math.Max(int64(length), Math.Max(4L, 2L * int64(Capacity)))))
        capacity = Math.Max(length, capacity)
        let result = Slice[T]([capacity]T, 0, length, capacity)
        AsSpan().CopyTo(result.AsSpan())
        return result
    }

    /// A by-value iterator over a saved descriptor, without modification version checks.
    struct Enumerator : IEnumerator[T] {
        private let slice Slice[T]
        private var index int32

        internal init(slice Slice[T]) {
            this.slice = slice
            index = -1
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        prop Current T -> slice[index]

        private prop(IEnumerator) Current object? -> Current

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        func MoveNext() bool {
            if index < slice.Length {
                index++
            }
            return index < slice.Length
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        func Reset() -> index = -1

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        func Dispose() { }
    }

    shared {
        /// Creates CLR-default elements with independent length and capacity.
        /// @param length The logical length.
        /// @param capacity The allocated capacity.
        /// @returns The new descriptor.
        func Create(length int32, capacity int32) Slice[T] {
            ArgumentOutOfRangeException.ThrowIfNegative(capacity, paramName: "capacity")
            if uint32(length) > uint32(capacity) {
                throw ArgumentOutOfRangeException("length")
            }
            return Slice[T]([capacity]T, 0, length, capacity)
        }

        /// Shares an entire exact-runtime-type array; covariant arrays are rejected.
        /// @param array The non-null exact `T` array.
        /// @returns A whole-array descriptor.
        func FromArray(array[]T) Slice[T] {
            ArgumentNullException.ThrowIfNull(array, paramName: "array")
            // Runtime handles intentionally require exact CLR identity, not a
            // structural name match or the compiler's metadata-context equivalence.
            if !array.GetType().TypeHandle.Equals(typeof([]T).TypeHandle) {
                throw ArrayTypeMismatchException()
            }
            return Slice[T](array, 0, array.Length, array.Length)
        }

        /// Recovers only exact-array-backed memory, without copying or widening its range.
        /// @param memory The logical memory range.
        /// @param result The slice, or default on failure.
        /// @returns Whether the memory has an admitted array owner.
        func TryFromMemory(memory Memory[T], out result Slice[T]) bool -> TryFromReadOnlyMemory(memory, out result)

        internal func TryFromReadOnlyMemory(memory ReadOnlyMemory[T], out result Slice[T]) bool {
            var memory = memory
            // TryGetArray normalizes empty non-array memory to Array.Empty<T>().
            // Reject those owners before that normalization loses their identity.
            if MemoryMarshal.TryGetMemoryManager[T, MemoryManager[T]](memory, out _) ||
                (
                typeof(T).TypeHandle.Equals(typeof(char).TypeHandle) && MemoryMarshal.TryGetString(
                    Unsafe.As[ReadOnlyMemory[T], ReadOnlyMemory[char]](&memory),
                    out _,
                    out _,
                    out _
                )
            ) {
                result = default(Slice[T])
                return false
            }
            if MemoryMarshal.TryGetArray(memory, out var segment) &&
                segment.Array is {} array &&
                array
                .GetType()
                .TypeHandle
                .Equals(typeof([]T).TypeHandle) {
                result = Slice[T](array, segment.Offset, segment.Count, segment.Count)
                return true
            }
            result = default(Slice[T])
            return false
        }

        private func ValidateIndexOperand(index int32) {
            if index < 0 {
                throw IndexOutOfRangeException()
            }
        }
    }
}

/// Compares descriptor identity, not contents.
/// @param left The left descriptor.
/// @param right The right descriptor.
/// @returns Whether the descriptors are identical.
func (left Slice[T]) operator == (right Slice[T]) bool -> left.Equals(right)

/// Compares descriptor identity, not contents.
/// @param left The left descriptor.
/// @param right The right descriptor.
/// @returns Whether the descriptors differ.
func (left Slice[T]) operator != (right Slice[T]) bool -> !left.Equals(right)
