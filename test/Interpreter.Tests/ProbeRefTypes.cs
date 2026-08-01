// <copyright file="ProbeRefTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Interpreter.Tests.ProbeRef;

/// <summary>
/// CLR interface with a default interface method (DIM). Used to verify
/// interpreter DIM dispatch parity with the emitter (#572 / #608).
/// </summary>
public interface IWithDIM
{
    /// <summary>Gets the name.</summary>
    string Name { get; }

    /// <summary>Default implementation: greeting computed from Name.</summary>
    string Greeting() => "Hello, " + Name + "!";
}

/// <summary>
/// Concrete implementation of <see cref="IWithDIM"/> that does NOT override
/// <see cref="IWithDIM.Greeting"/>. DIM dispatch must find the default body.
/// </summary>
public class WithDIMImpl : IWithDIM
{
    /// <summary>Initializes a new instance of the <see cref="WithDIMImpl"/> class.</summary>
    /// <param name="name">The name.</param>
    public WithDIMImpl(string name)
    {
        Name = name;
    }

    /// <inheritdoc/>
    public string Name { get; }
}

/// <summary>
/// CLR interface with a getter-only property contract (#573 shape).
/// </summary>
public interface IHasName
{
    /// <summary>Gets the name.</summary>
    string Name { get; }
}

/// <summary>
/// CLR interface with a read-write property contract (#606 shape).
/// </summary>
public interface IReadWrite
{
    /// <summary>Gets or sets the value.</summary>
    string Value { get; set; }
}
