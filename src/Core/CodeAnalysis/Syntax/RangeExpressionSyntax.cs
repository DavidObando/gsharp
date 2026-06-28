#nullable disable

// <copyright file="RangeExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1016: represents a range/slice expression <c>lo..hi</c> with its
/// open-ended forms <c>..hi</c>, <c>lo..</c>, and <c>..</c>. Currently produced
/// only as the operand of an index expression (<c>a[lo..hi]</c>), where it
/// lowers to a slice of the indexed array, slice, string, or span-like value.
/// </summary>
public sealed class RangeExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="RangeExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="lowerBound">The optional inclusive lower bound, or
    /// <see langword="null"/> for the open form (<c>..hi</c>).</param>
    /// <param name="dotDotToken">The <c>..</c> operator token.</param>
    /// <param name="upperBound">The optional exclusive upper bound, or
    /// <see langword="null"/> for the open form (<c>lo..</c>).</param>
    public RangeExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax lowerBound,
        SyntaxToken dotDotToken,
        ExpressionSyntax upperBound)
        : base(syntaxTree)
    {
        LowerBound = lowerBound;
        DotDotToken = dotDotToken;
        UpperBound = upperBound;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.RangeExpression;

    /// <summary>Gets the inclusive lower bound, or <see langword="null"/> when open.</summary>
    public ExpressionSyntax LowerBound { get; }

    /// <summary>Gets the <c>..</c> operator token.</summary>
    public SyntaxToken DotDotToken { get; }

    /// <summary>Gets the exclusive upper bound, or <see langword="null"/> when open.</summary>
    public ExpressionSyntax UpperBound { get; }
}
