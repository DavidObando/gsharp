// <copyright file="SuspendingAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// Marks a method the G# compiler emitted as <em>suspending</em> (ADR-0174 D4):
/// its CLR return type is <see cref="ValueTask"/> or <see cref="ValueTask{TResult}"/>,
/// but its logical G# return type is the unwrapped <c>R</c>, and a G# call site
/// awaits it implicitly. The attribute is a label the compiler reads from
/// metadata across assemblies; it does not change how the CLR calls the method.
/// </summary>
/// <remarks>
/// A public suspending function without an explicit <c>Context</c> parameter is
/// emitted twice (ADR-0174 D7): a private implementation taking the hidden
/// leading <see cref="Context"/> parameter, and a public bridge that supplies
/// <see cref="Context.None"/>. The bridge carries this attribute with
/// <see cref="ImplementationName"/> naming the implementation, so a G# caller
/// with an ambient context binds the implementation and everyone else gets the
/// bridge.
/// </remarks>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = false)]
public sealed class SuspendingAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="SuspendingAttribute"/> class for a method that is itself the implementation.</summary>
    public SuspendingAttribute()
    {
    }

    /// <summary>Initializes a new instance of the <see cref="SuspendingAttribute"/> class for a public bridge.</summary>
    /// <param name="implementationName">The name of the private implementation method that takes the hidden <see cref="Context"/> parameter.</param>
    public SuspendingAttribute(string? implementationName)
    {
        ImplementationName = implementationName;
    }

    /// <summary>Gets the name of the context-taking implementation this bridge forwards to, or <see langword="null"/> when this method is the implementation.</summary>
    public string? ImplementationName { get; }
}
