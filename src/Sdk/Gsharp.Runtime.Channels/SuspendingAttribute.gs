// <copyright file="SuspendingAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System

/// Marks a method the G# compiler emitted as <em>suspending</em> (ADR-0174 D4):
/// its CLR return type is (cref:ValueTask) or (cref:ValueTask{TResult}),
/// but its logical G# return type is the unwrapped `R`, and a G# call site
/// awaits it implicitly. The attribute is a label the compiler reads from
/// metadata across assemblies; it does not change how the CLR calls the method.
/// @remarks A public suspending function without an explicit `Context` parameter is
/// emitted twice (ADR-0174 D7): a private implementation taking the hidden
/// leading (cref:Context) parameter, and a public bridge that supplies
/// (cref:Context.None). The bridge carries this attribute with
/// (cref:ImplementationName) naming the implementation, so a G# caller
/// with an ambient context binds the implementation and everyone else gets the
/// bridge.
@AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = false)
class SuspendingAttribute : Attribute {
    /// Initializes a new instance of the (cref:SuspendingAttribute) class for a method that is itself the
    /// implementation.
    init() { }

    /// Initializes a new instance of the (cref:SuspendingAttribute) class for a public bridge.
    /// @param implementationName The name of the private implementation method that takes the hidden
    /// (cref:Context) parameter.
    init(implementationName string?) {
        ImplementationName = implementationName
    }

    /// Gets the name of the context-taking implementation this bridge forwards to, or `null` when this
    /// method is the implementation.
    prop ImplementationName string? {
        get;
    }
}
