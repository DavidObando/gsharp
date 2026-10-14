// <copyright file="BoundInterpolatedStringPart.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis

/// One part of a (cref:BoundInterpolatedStringExpression): either a
/// constant literal segment or an embedded hole expression with optional
/// alignment and format specifiers.
struct BoundInterpolatedStringPart {
    private init(literal string?, value BoundExpression?, alignment int32?, format string?, holeSyntax SyntaxNode?) {
        Literal = literal
        Value = value
        Alignment = alignment
        Format = format
        HoleSyntax = holeSyntax
    }

    /// Gets a value indicating whether this part is a hole (an embedded expression).
    @MemberNotNullWhen(true, "Value")
    prop IsHole bool -> Value != nil

    /// Gets a value indicating whether this part is literal text.
    @MemberNotNullWhen(false, "Value")
    prop IsLiteral bool -> Value == nil

    /// Gets the literal text, or `null` when this part is a hole.
    prop Literal string? {
        get;
    }

    /// Gets the hole expression, or `null` when this part is literal text.
    prop Value BoundExpression? {
        get;
    }

    /// Gets the hole's alignment (signed field width; negative = left-justify), or `null`.
    prop Alignment int32? {
        get;
    }

    /// Gets the hole's format specifier (e.g. `N2`, `X4`), or `null`.
    prop Format string? {
        get;
    }

    /// Gets the hole's own syntax, or `null` when this part is literal text.
    prop HoleSyntax SyntaxNode? {
        get;
    }

    /// Returns a copy of this hole with a different bound value (used by tree rewriters).
    /// @param value The replacement hole expression.
    /// @returns The updated part.
    func WithValue(value BoundExpression) BoundInterpolatedStringPart -> BoundInterpolatedStringPart(
        Literal,
        value,
        Alignment,
        Format,
        HoleSyntax
    )

    shared {
        /// Creates a literal-text part.
        /// @param text The literal text.
        /// @returns The part.
        func FromLiteral(text string) BoundInterpolatedStringPart -> BoundInterpolatedStringPart(
            text ?? string.Empty,
            value: nil,
            alignment: nil,
            format: nil,
            holeSyntax: nil
        )

        /// Creates a hole part.
        /// @param value The bound hole expression.
        /// @param alignment The optional alignment.
        /// @param format The optional format specifier.
        /// @param holeSyntax The hole's own syntax, used to anchor hole-level diagnostics.
        /// @returns The part.
        func FromHole(
            value BoundExpression,
            alignment int32?,
            format string?,
            holeSyntax SyntaxNode? = nil
        ) BoundInterpolatedStringPart -> BoundInterpolatedStringPart(literal: nil, value, alignment, format, holeSyntax)
    }
}
