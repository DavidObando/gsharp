// <copyright file="InterpolatedStringSegment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// One segment of an (cref:InterpolatedStringExpressionSyntax): either
/// a literal piece of text or an embedded expression with optional alignment
/// and format specifiers (ADR-0055: `${expr,alignment:format}`).
struct InterpolatedStringSegment {
    private init(text string?, expression ExpressionSyntax?, alignment int32?, format string?) {
        Text = text
        Expression = expression
        Alignment = alignment
        Format = format
    }

    /// Gets a value indicating whether this segment holds an embedded expression.
    prop IsExpression bool -> Expression != nil

    /// Gets the literal text, or `null` when this segment is an expression.
    prop Text string? {
        get;
    }

    /// Gets the embedded expression, or `null` when this segment is literal text.
    prop Expression ExpressionSyntax? {
        get;
    }

    /// Gets the optional constant alignment from a `${expr,alignment}` hole
    /// (ADR-0055). A negative value left-justifies (C# parity). `null` when
    /// no alignment clause was present.
    prop Alignment int32? {
        get;
    }

    /// Gets the optional format specifier from a `${expr:format}` hole
    /// (ADR-0055), verbatim and without the leading colon. `null` when no
    /// format clause was present.
    prop Format string? {
        get;
    }

    shared {
        /// Creates a literal-text segment.
        /// @param text The literal text.
        /// @returns The segment.
        func FromText(text string) InterpolatedStringSegment -> InterpolatedStringSegment(
            text,
            expression: nil,
            alignment: nil,
            format: nil
        )

        /// Creates an embedded-expression segment.
        /// @param expression The bound expression syntax.
        /// @param alignment The optional constant alignment.
        /// @param format The optional format specifier (without the leading colon).
        /// @returns The segment.
        func FromExpression(
            expression ExpressionSyntax,
            alignment int32? = nil,
            format string? = nil
        ) InterpolatedStringSegment -> InterpolatedStringSegment(text: nil, expression, alignment, format)
    }
}
