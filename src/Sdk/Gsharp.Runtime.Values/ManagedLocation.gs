// <copyright file="ManagedLocation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

/// Compiler-facing common identity contract. Subclasses must describe stable
/// GC-owned storage and their Borrow implementation must identify that storage.
/// @typeparam T The invariant referent type.
abstract class ManagedLocation[T] {
    open func GetLocation() ManagedLocationKey;

    func SameLocation(other ManagedLocation[T]?) bool -> other != nil && GetLocation().Equals(other.GetLocation())

    open override func Equals(obj object?) bool -> obj is ManagedLocation[T]other && SameLocation(other)

    open override func GetHashCode() int32 -> GetLocation().GetHashCode()
}
