// <copyright file="ManagedRef.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

import System
import System.Threading

/// A writable heap-storable location; copying it does not copy T.
/// @typeparam T The invariant referent type.
abstract class ManagedRef[T] : ManagedLocation[T] {
    open func Borrow() ref T;

    func AsReadOnly() ReadOnlyManagedRef[T] -> ReadOnlyView(this)

    override func Equals(obj object?) bool -> base.Equals(obj)

    override func GetHashCode() int32 -> base.GetHashCode()

    private class ArrayLocation(owner[]T, index int32) : ManagedRef[T] {
        private var location ManagedLocationKey?

        override func Borrow() ref T {
            return ref owner[index]
        }

        override func GetLocation() ManagedLocationKey {
            let cached ManagedLocationKey? = Volatile.Read(&location)
            if cached != nil {
                return cached
            }
            let created = ManagedLocationKey.Element(owner, index)
            return Interlocked.CompareExchange(&location, created, nil) ?? created
        }
    }

    private class ReadOnlyView(source ManagedRef[T]) : ReadOnlyManagedRef[T] {
        override func Borrow() ref readonly T {
            return ref source.Borrow()
        }

        override func GetLocation() ManagedLocationKey -> source.GetLocation()
    }

    shared {
        func FromArray(array[]T, index int32) ManagedRef[T] -> FromArrayNative(array, index)

        func FromArrayNative(array[]T, index nint) ManagedRef[T] {
            CheckArray(array, index)
            return ArrayLocation(array, int32(index))
        }

        internal func CheckArray(array[]T, index nint) {
            ArgumentNullException.ThrowIfNull(array, paramName: "array")
            if !array.GetType().Equals(typeof([]T)) {
                throw ArrayTypeMismatchException()
            }
            if nuint(index) >= nuint(array.Length) {
                throw IndexOutOfRangeException()
            }
        }
    }
}

func (left ManagedRef[T]?) operator == (right ManagedRef[T]?) bool -> object.ReferenceEquals(left, right) ||
    (left != nil && left.SameLocation(right))

func (left ManagedRef[T]?) operator != (right ManagedRef[T]?) bool -> !(left == right)
