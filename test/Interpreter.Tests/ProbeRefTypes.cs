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

/// <summary>
/// CLR ref-return members used to pin managed-byref auto-dereference.
/// </summary>
public sealed class RefReturnProbe
{
    private readonly int[] values = [40, 41, 42];

    /// <summary>Gets the first value by reference.</summary>
    public ref int Property => ref values[0];

    /// <summary>Gets a value by reference through an indexer.</summary>
    /// <param name="index">The value index.</param>
    public ref int this[int index] => ref values[index];

    /// <summary>Gets a value by reference through an instance call.</summary>
    /// <param name="index">The value index.</param>
    /// <returns>A reference to the selected value.</returns>
    public ref int GetValue(int index) => ref values[index];
}
