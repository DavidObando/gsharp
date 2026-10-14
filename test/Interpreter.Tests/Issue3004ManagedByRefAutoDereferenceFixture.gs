// <copyright file="Issue3004ManagedByRefAutoDereferenceFixture.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests.Issue3004

/// CLR ref-return shapes used to guard managed-byref auto-dereference.
class ManagedByRefAutoDereferenceFixture {
    private let values[]int32 = []int32{40, 41, 42}

    /// Gets the first value by reference.
    prop Property ref int32 -> values[0]

    /// Gets a value by reference through an indexer.
    /// @param index The value index.
    prop this[index int32]ref int32 -> values[index]

    /// Gets a value by reference through an instance call.
    /// @param index The value index.
    /// @returns A reference to the selected value.
    func GetValue(index int32) ref int32 {
        return ref values[index]
    }
}
