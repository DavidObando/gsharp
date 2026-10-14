// <copyright file="ReadOnlySlice.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

import System
import System.Collections
import System.Collections.Generic

/// A shared slice descriptor that grants only readonly element access.
/// @typeparam T The invariant element type.
struct ReadOnlySlice[T] : IEquatable[ReadOnlySlice[T]], IEnumerable[T] {
    private let slice Slice[T]

    internal init(slice Slice[T]) {
        this.slice = slice
    }

    /// Gets the logical length.
    prop Length int32 -> slice.Length

    /// Gets the available reslicing capacity.
    prop Capacity int32 -> slice.Capacity

    /// Gets a value indicating whether the logical range is empty.
    prop IsEmpty bool -> slice.IsEmpty

    /// Gets a readonly reference to a logical element.
    /// @param index The zero-based logical index.
    /// @returns The readonly backing element.
    prop this[index int32]ref readonly T -> slice[index]

    /// Gets a readonly reference using a from-end index.
    /// @param index The logical index.
    /// @returns The readonly backing element.
    prop this[index Index]ref readonly T -> slice[index]

    /// Gets an element after validating a native from-end operand.
    /// @param index The written nonnegative index operand.
    /// @param fromEnd Whether it is relative to Length.
    /// @returns The readonly backing element.
    prop this[index int32, fromEnd bool]ref readonly T -> slice[index, fromEnd]

    /// Weakens permissions without copying elements.
    /// @param value The mutable descriptor.
    func operator implicit(value Slice[T]) ReadOnlySlice[T] -> value.AsReadOnly()

    /// Retains a selected element without granting writable access.
    /// @param index The logical element index.
    /// @returns A persistent readonly location.
    func GetReadOnlyManagedReference(index int32) ReadOnlyManagedRef[T] -> slice.GetReadOnlyManagedReference(index)

    /// Retains a readonly element using a from-end index.
    /// @param index The logical index.
    /// @returns A persistent readonly location.
    func GetReadOnlyManagedReference(index Index) ReadOnlyManagedRef[T] -> slice.GetReadOnlyManagedReference(index)

    /// Retains a native-syntax readonly element after checking its operand.
    /// @param index The written nonnegative operand.
    /// @param fromEnd Whether the operand is relative to Length.
    /// @returns A persistent readonly location.
    func GetReadOnlyManagedReference(index int32, fromEnd bool) ReadOnlyManagedRef[
        T
    ] -> slice.GetReadOnlyManagedReference(index, fromEnd)

    /// Returns a shared view using exclusive endpoints.
    /// @param lo The inclusive lower endpoint.
    /// @param hi The exclusive upper endpoint.
    /// @returns The readonly view.
    func Subslice(lo int32, hi int32) ReadOnlySlice[T] -> slice.Subslice(lo, hi).AsReadOnly()

    /// Returns a shared view from a saved exclusive-endpoint range.
    /// @param range The saved range.
    /// @returns The readonly view.
    func Subslice($range Range) ReadOnlySlice[T] -> slice.Subslice($range).AsReadOnly()

    /// Returns a capacity-limited shared view.
    /// @param lo The inclusive lower endpoint.
    /// @param hi The exclusive upper endpoint.
    /// @param max The exclusive capacity endpoint.
    /// @returns The readonly view.
    func Subslice(lo int32, hi int32, max int32) ReadOnlySlice[T] -> slice.Subslice(lo, hi, max).AsReadOnly()

    /// Normalizes native bounds after argument evaluation.
    /// @param lo The written lower bound.
    /// @param hi The written upper bound.
    /// @param lowerFromEnd Whether the lower bound is relative to Length.
    /// @param upperFromEnd Whether the upper bound is relative to Length.
    /// @returns The readonly view.
    func Subslice(lo int32, hi int32, lowerFromEnd bool, upperFromEnd bool) ReadOnlySlice[T] -> slice.Subslice(
        lo,
        hi,
        lowerFromEnd,
        upperFromEnd
    )
        .AsReadOnly()

    /// Copies the shorter logical length using overlap-safe copying.
    /// @param destination The writable destination.
    /// @returns The number of elements copied.
    func CopyTo(destination Slice[T]) int32 {
        let count = Math.Min(Length, destination.Length)
        AsSpan()[.. count].CopyTo(destination.AsSpan())
        return count
    }

    /// Creates an independent mutable shallow copy.
    /// @returns The new descriptor with capacity equal to length.
    func Clone() Slice[T] -> slice.Clone()

    /// Copies the logical range to an independent array.
    /// @returns The copied array.
    func ToArray()[]T -> slice.ToArray()

    /// Borrows readonly access to exactly the logical range.
    /// @returns The shared readonly span.
    func AsSpan() ReadOnlySpan[T] -> slice.AsSpan()

    /// Shares readonly access to exactly the logical range.
    /// @returns The shared readonly memory.
    func AsMemory() ReadOnlyMemory[T] -> slice.AsMemory()

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Equals(other ReadOnlySlice[T]) bool -> slice.Equals(other.slice)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Equals(obj object?) bool -> obj is ReadOnlySlice[T]other && Equals(other)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetHashCode() int32 -> slice.GetHashCode()

    /// Iterates saved Length, loading each element by value when visited.
    /// @returns An allocation-free value enumerator.
    func GetEnumerator() Slice[T].Enumerator -> slice.GetEnumerator()

    private func (IEnumerable[T]) GetEnumerator() IEnumerator[T] -> GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()

    shared {
        /// Shares a non-null exact array after rejecting covariance.
        /// @param array The exact array.
        /// @returns The readonly whole-array descriptor.
        func FromArray(array[]T) ReadOnlySlice[T] -> Slice[T].FromArray(array).AsReadOnly()

        /// Recovers only exact-array-backed readonly memory without copying.
        /// @param memory The logical range.
        /// @param result The recovered descriptor, or default on failure.
        /// @returns Whether the owner is admitted.
        func TryFromMemory(memory ReadOnlyMemory[T], out result ReadOnlySlice[T]) bool {
            let success = Slice[T].TryFromReadOnlyMemory(memory, out var recovered)
            result = recovered.AsReadOnly()
            return success
        }
    }
}

/// Compares descriptor identity, not contents.
/// @param left The left descriptor.
/// @param right The right descriptor.
/// @returns Whether the descriptors are identical.
func (left ReadOnlySlice[T]) operator == (right ReadOnlySlice[T]) bool -> left.Equals(right)

/// Compares descriptor identity, not contents.
/// @param left The left descriptor.
/// @param right The right descriptor.
/// @returns Whether the descriptors differ.
func (left ReadOnlySlice[T]) operator != (right ReadOnlySlice[T]) bool -> !left.Equals(right)
