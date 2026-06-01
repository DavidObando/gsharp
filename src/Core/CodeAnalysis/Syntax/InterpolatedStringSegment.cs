// <copyright file="InterpolatedStringSegment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// One segment of an <see cref="InterpolatedStringExpressionSyntax"/>: either
/// a literal piece of text or an embedded expression.
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

    /// <summary>
    /// Gets the optional constant alignment from a <c>${expr,alignment}</c> hole
    /// (ADR-0055). A negative value left-justifies (C# parity). <c>null</c> when
    /// no alignment clause was present.
    /// </summary>
    public int? Alignment { get; }

    /// <summary>
    /// Gets the optional format specifier from a <c>${expr:format}</c> hole
    /// (ADR-0055), verbatim and without the leading colon. <c>null</c> when no
    /// format clause was present.
    /// </summary>
    public string Format { get; }

    /// <summary>Creates a literal-text segment.</summary>
    /// <param name="text">The literal text.</param>
    /// <returns>The segment.</returns>
    public static InterpolatedStringSegment FromText(string text) => new(text, expression: null, alignment: null, format: null);

    /// <summary>Creates an embedded-expression segment.</summary>
    /// <param name="expression">The bound expression syntax.</param>
    /// <param name="alignment">The optional constant alignment.</param>
    /// <param name="format">The optional format specifier (without the leading colon).</param>
    /// <returns>The segment.</returns>
    public static InterpolatedStringSegment FromExpression(ExpressionSyntax expression, int? alignment = null, string format = null) => new(text: null, expression, alignment, format);
}
