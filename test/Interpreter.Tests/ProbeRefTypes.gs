// <copyright file="ProbeRefTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests.ProbeRef

/// CLR interface with a default interface method (DIM). Used to verify
/// emitted-session DIM dispatch coverage (#572 / #608).
interface IWithDIM {
    /// Gets the name.
    prop Name string {
        get;
    }

    /// Default implementation: greeting computed from Name.
    func Greeting() string {
        return "Hello, " + Name + "!"
    }
}

/// Concrete implementation of (cref:IWithDIM) that does NOT override
/// (cref:IWithDIM.Greeting). DIM dispatch must find the default body.
open class WithDIMImpl : IWithDIM {
    /// Initializes a new instance of the (cref:WithDIMImpl) class.
    /// @param name The name.
    init(name string) {
        Name = name
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Name string {
        get;
    }
}

/// CLR interface with a getter-only property contract (#573 shape).
interface IHasName {
    /// Gets the name.
    prop Name string {
        get;
    }
}

/// CLR interface with a read-write property contract (#606 shape).
interface IReadWrite {
    /// Gets or sets the value.
    prop Value string {
        get;
        set;
    }
}

/// Generic CLR static property used by symbolic-container emitted-session tests.
shared class GenericStaticSlot[T] {
    /// Gets or sets the per-construction value.
    prop Value int32

    /// Returns a marker that identifies the closed generic construction.
    func GetMarker() int32 -> if typeof(T) == typeof(int32) {
        11
    } else {
        -11
    }
}
