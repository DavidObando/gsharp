// <copyright file="BoundAttributeArgument.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A single argument to a bound attribute application — either a positional
/// constructor argument (<see cref="Name"/> is <c>null</c>) or a named
/// argument that binds to a public field or property on the attribute type.
/// Per ADR-0047 §3 / ECMA-335 II.23.3 only compile-time constants of the
/// recognised attribute-argument value space are permitted.
/// </summary>
public sealed record BoundAttributeArgument
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAttributeArgument"/> class.
    /// </summary>
    /// <param name="name">Property/field name for named arguments; <c>null</c> for positional.</param>
    /// <param name="value">The constant value of the argument.</param>
    /// <param name="type">The static type of the argument.</param>
    public BoundAttributeArgument(string name, object value, TypeSymbol type)
    {
        Name = name;
        Value = value;
        Type = type;
    }

    /// <summary>
    /// Gets the field or property name for a named argument, or <c>null</c> for a positional argument.
    /// </summary>
    public string Name { get; }

    /// <summary>
    /// Gets the compile-time constant value of the argument.
    /// </summary>
    public object Value { get; }

    /// <summary>
    /// Gets the static type of the argument.
    /// </summary>
    public TypeSymbol Type { get; }
}
