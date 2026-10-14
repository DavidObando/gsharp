// <copyright file="Issue3076ProbeRefTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests.Issue3076Probe

/// CLR generic static storage used by issue #3076 emitted-session tests.
shared class GenericStaticSlot[T] {
    /// Gets or sets per-construction property storage.
    prop Property int32

    /// Per-construction field storage.
    var Field int32

    /// Reads per-construction property storage from the fixture assembly.
    /// @returns The property value.
    func ReadProperty() int32 -> Property

    /// Reads per-construction field storage from the fixture assembly.
    /// @returns The field value.
    func ReadField() int32 -> Field
}

/// CLR two-parameter generic static storage used by issue #3076 emitted-session tests.
shared class GenericPairSlot[TFirst, TSecond] {
    /// Gets or sets per-construction property storage.
    prop Property int32

    /// Per-construction field storage.
    var Field int32
}

/// CLR generic type used as a nested type argument by issue #3076 tests.
class GenericBox[T] { }

/// CLR non-generic static-storage control used by issue #3076 tests.
shared class PlainStaticSlot {
    /// Gets or sets property storage.
    prop Property int32

    /// Field storage.
    var Field int32
}
