// <copyright file="BoundAttributeArgument.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A single argument to a bound attribute application — a positional
/// constructor argument, a colon-named constructor argument, or an
/// equals-named public field/property assignment.
/// Per ADR-0047 §3 / ECMA-335 II.23.3 only compile-time constants of the
/// recognised attribute-argument value space are permitted.
/// </summary>
public sealed record BoundAttributeArgument
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAttributeArgument"/> class.
    /// </summary>
    /// <param name="name">Constructor parameter or member name; <c>null</c> for positional.</param>
    /// <param name="value">The constant value of the argument.</param>
    /// <param name="type">The static type of the argument.</param>
    /// <param name="syntax">The originating argument syntax, when available.</param>
    /// <param name="isMemberAssignment">Whether attribute-specific <c>Name = value</c> syntax selected a property or field.</param>
    public BoundAttributeArgument(
        string? name,
        object? value,
        TypeSymbol type,
        SyntaxNode? syntax = null,
        bool isMemberAssignment = false)
    {
        Name = name;
        Value = value;
        Type = type;
        Syntax = syntax;
        IsMemberAssignment = isMemberAssignment;
    }

    /// <summary>
    /// Gets the constructor parameter or member name, or <c>null</c> for a positional argument.
    /// </summary>
    public string? Name { get; }

    /// <summary>
    /// Gets the compile-time constant value of the argument.
    /// </summary>
    public object? Value { get; }

    /// <summary>
    /// Gets the static type of the argument.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>Gets the originating argument syntax, when available.</summary>
    public SyntaxNode? Syntax { get; }

    /// <summary>Gets a value indicating whether this argument explicitly targets a property or field.</summary>
    public bool IsMemberAssignment { get; }
}
