// <copyright file="ReadOnlyManagedRef.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

import System.Threading

/// A shallow readonly location, with no upgrade to writable storage.
/// @typeparam T The invariant referent type.
abstract class ReadOnlyManagedRef[T] : ManagedLocation[T] {
    open func Borrow() ref readonly T;

    override func Equals(obj object?) bool -> base.Equals(obj)

    override func GetHashCode() int32 -> base.GetHashCode()

    private class ArrayLocation(owner[]T, index int32) : ReadOnlyManagedRef[T] {
        private var location ManagedLocationKey?

        override func Borrow() ref readonly T {
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

    shared {
        func FromArray(array[]T, index int32) ReadOnlyManagedRef[T] -> FromArrayNative(array, index)

        func FromArrayNative(array[]T, index nint) ReadOnlyManagedRef[T] {
            ManagedRef[T].CheckArray(array, index)
            return ArrayLocation(array, int32(index))
        }
    }
}

func (left ReadOnlyManagedRef[T]?) operator == (right ReadOnlyManagedRef[T]?) bool -> object.ReferenceEquals(
    left,
    right
) ||
    (left != nil && left.SameLocation(right))

func (left ReadOnlyManagedRef[T]?) operator != (right ReadOnlyManagedRef[T]?) bool -> !(left == right)
