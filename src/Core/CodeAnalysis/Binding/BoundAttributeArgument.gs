// <copyright file="BoundAttributeArgument.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System

/// A single argument to a bound attribute application — a positional
/// constructor argument, a colon-named constructor argument, or an
/// equals-named public field/property assignment.
/// Per ADR-0047 §3 / ECMA-335 II.23.3 only compile-time constants of the
/// recognised attribute-argument value space are permitted.
data class BoundAttributeArgument : IEquatable[BoundAttributeArgument] {
    /// Initializes a new instance of the (cref:BoundAttributeArgument) class.
    /// @param name Constructor parameter or member name; `null` for positional.
    /// @param value The constant value of the argument.
    /// @param type The static type of the argument.
    /// @param syntax The originating argument syntax, when available.
    /// @param isMemberAssignment Whether attribute-specific `Name = value` syntax selected a property or
    /// field.
    init(name string?, value object?, type TypeSymbol, syntax SyntaxNode? = nil, isMemberAssignment bool = false) {
        Name = name
        Value = value
        Type = type
        Syntax = syntax
        IsMemberAssignment = isMemberAssignment
    }

    /// Gets the constructor parameter or member name, or `null` for a positional argument.
    prop Name string? {
        get;
    }

    /// Gets the compile-time constant value of the argument.
    prop Value object? {
        get;
    }

    /// Gets the static type of the argument.
    prop Type TypeSymbol {
        get;
    }

    /// Gets the originating argument syntax, when available.
    prop Syntax SyntaxNode? {
        get;
    }

    /// Gets a value indicating whether this argument explicitly targets a property or field.
    prop IsMemberAssignment bool {
        get;
    }
}
