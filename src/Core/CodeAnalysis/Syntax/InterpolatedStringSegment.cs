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
    private InterpolatedStringSegment(string text, ExpressionSyntax expression)
    {
        Text = text;
        Expression = expression;
    }

    /// <summary>Gets a value indicating whether this segment holds an embedded expression.</summary>
    public bool IsExpression => Expression != null;

    /// <summary>Gets the literal text, or <c>null</c> when this segment is an expression.</summary>
    public string Text { get; }

    /// <summary>Gets the embedded expression, or <c>null</c> when this segment is literal text.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Creates a literal-text segment.</summary>
    /// <param name="text">The literal text.</param>
    /// <returns>The segment.</returns>
    public static InterpolatedStringSegment FromText(string text) => new(text, expression: null);

    /// <summary>Creates an embedded-expression segment.</summary>
    /// <param name="expression">The bound expression syntax.</param>
    /// <returns>The segment.</returns>
    public static InterpolatedStringSegment FromExpression(ExpressionSyntax expression) => new(text: null, expression);
}
