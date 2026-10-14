// <copyright file="ManagedLocationKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

import System
import System.Runtime.CompilerServices

/// Immutable compiler-facing location identity. Field tokens are paired with
/// their constructed declaring types; neither wrapper identity nor mutable
/// referent contents participate in equality.
class ManagedLocationKey : IEquatable[ManagedLocationKey] {
    private let owner object
    private let index int32
    private let path[](Field RuntimeFieldHandle, Type RuntimeTypeHandle) = System
        .Array
        .Empty[(Field RuntimeFieldHandle, Type RuntimeTypeHandle)]()
    private let hash int32

    private init(owner object, index int32, path[](RuntimeFieldHandle, RuntimeTypeHandle)) {
        ArgumentNullException.ThrowIfNull(owner, paramName: "owner")
        this.owner = owner
        this.index = index
        this.path = path
        var value = default(HashCode)
        value.Add(RuntimeHelpers.GetHashCode(owner))
        value.Add(index)
        for field in path {
            value.Add(field)
        }
        hash = value.ToHashCode()
    }

    func Field(field RuntimeFieldHandle, declaringType RuntimeTypeHandle) ManagedLocationKey {
        let fields = [path.Length + 1](RuntimeFieldHandle, RuntimeTypeHandle)
        path.CopyTo(fields, 0)
        fields[^1] = (field, declaringType)
        return ManagedLocationKey(owner, index, fields)
    }

    func Equals(other ManagedLocationKey?) bool -> other != nil && object.ReferenceEquals(owner, other.owner) &&
        index == other.index &&
        path
        .AsSpan().SequenceEqual(other.path)

    override func Equals(obj object?) bool -> obj is ManagedLocationKey other && Equals(other)

    override func GetHashCode() int32 -> hash

    shared {
        func Object(owner object) ManagedLocationKey -> ManagedLocationKey(
            owner,
            -1,
            System.Array.Empty[(RuntimeFieldHandle, RuntimeTypeHandle)]()
        )

        internal func Element(owner object, index int32) ManagedLocationKey -> ManagedLocationKey(
            owner,
            index,
            System.Array.Empty[(RuntimeFieldHandle, RuntimeTypeHandle)]()
        )
    }
}
