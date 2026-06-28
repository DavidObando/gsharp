#nullable disable

// <copyright file="BoundInterpolatedStringPart.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// One part of a <see cref="BoundInterpolatedStringExpression"/>: either a
/// constant literal segment or an embedded hole expression with optional
/// alignment and format specifiers.
/// </summary>
public readonly struct BoundInterpolatedStringPart
{
    private BoundInterpolatedStringPart(string literal, BoundExpression value, int? alignment, string format)
    {
        Literal = literal;
        Value = value;
        Alignment = alignment;
        Format = format;
    }

    /// <summary>Gets a value indicating whether this part is a hole (an embedded expression).</summary>
    public bool IsHole => Value != null;

    /// <summary>Gets a value indicating whether this part is literal text.</summary>
    public bool IsLiteral => Value == null;

    /// <summary>Gets the literal text, or <c>null</c> when this part is a hole.</summary>
    public string Literal { get; }

    /// <summary>Gets the hole expression, or <c>null</c> when this part is literal text.</summary>
    public BoundExpression Value { get; }

    /// <summary>Gets the hole's alignment (signed field width; negative = left-justify), or <c>null</c>.</summary>
    public int? Alignment { get; }

    /// <summary>Gets the hole's format specifier (e.g. <c>N2</c>, <c>X4</c>), or <c>null</c>.</summary>
    public string Format { get; }

    /// <summary>Creates a literal-text part.</summary>
    /// <param name="text">The literal text.</param>
    /// <returns>The part.</returns>
    public static BoundInterpolatedStringPart FromLiteral(string text)
        => new(text ?? string.Empty, value: null, alignment: null, format: null);

    /// <summary>Creates a hole part.</summary>
    /// <param name="value">The bound hole expression.</param>
    /// <param name="alignment">The optional alignment.</param>
    /// <param name="format">The optional format specifier.</param>
    /// <returns>The part.</returns>
    public static BoundInterpolatedStringPart FromHole(BoundExpression value, int? alignment, string format)
        => new(literal: null, value, alignment, format);

    /// <summary>Returns a copy of this hole with a different bound value (used by tree rewriters).</summary>
    /// <param name="value">The replacement hole expression.</param>
    /// <returns>The updated part.</returns>
    public BoundInterpolatedStringPart WithValue(BoundExpression value)
        => new(Literal, value, Alignment, Format);
}
