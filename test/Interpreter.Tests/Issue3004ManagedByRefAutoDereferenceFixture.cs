// <copyright file="Issue3004ManagedByRefAutoDereferenceFixture.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Interpreter.Tests.Issue3004;

/// <summary>
/// CLR ref-return shapes used to guard managed-byref auto-dereference.
/// </summary>
public sealed class ManagedByRefAutoDereferenceFixture
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
