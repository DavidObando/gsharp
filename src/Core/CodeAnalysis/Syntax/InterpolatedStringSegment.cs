// <copyright file="InterpolatedStringSegment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// One segment of an <see cref="InterpolatedStringExpressionSyntax"/>: either
/// a literal piece of text or an embedded expression with optional alignment
/// and format specifiers (ADR-0055: <c>${expr,alignment:format}</c>).
/// </summary>
public readonly struct InterpolatedStringSegment
{
    private InterpolatedStringSegment(string text, ExpressionSyntax expression, int? alignment, string format)
    {
        Text = text;
        Expression = expression;
        Alignment = alignment;
        Format = format;
    }

    /// <summary>Gets a value indicating whether this segment holds an embedded expression.</summary>
    public bool IsExpression => Expression != null;

    /// <summary>Gets the literal text, or <c>null</c> when this segment is an expression.</summary>
    public string Text { get; }

    /// <summary>Gets the embedded expression, or <c>null</c> when this segment is literal text.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the alignment specifier (signed field width; negative left-justifies), or <c>null</c>.</summary>
    public int? Alignment { get; }

    /// <summary>Gets the format specifier (e.g. <c>N2</c>), or <c>null</c> when none was supplied.</summary>
    public string Format { get; }

    /// <summary>Creates a literal-text segment.</summary>
    /// <param name="text">The literal text.</param>
    /// <returns>The segment.</returns>
    public static InterpolatedStringSegment FromText(string text) => new(text, expression: null, alignment: null, format: null);

    /// <summary>Creates an embedded-expression segment.</summary>
    /// <param name="expression">The bound expression syntax.</param>
    /// <param name="alignment">The optional alignment specifier.</param>
    /// <param name="format">The optional format specifier.</param>
    /// <returns>The segment.</returns>
    public static InterpolatedStringSegment FromExpression(ExpressionSyntax expression, int? alignment = null, string format = null)
        => new(text: null, expression, alignment, format);
}
