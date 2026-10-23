// <copyright file="RangeExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #1016: represents a range/slice expression `lo..hi` with its
/// open-ended forms `..hi`, `lo..`, and `..`. Currently produced
/// only as the operand of an index expression (`a[lo..hi]`), where it
/// lowers to a slice of the indexed array, slice, string, or span-like value.
partial class RangeExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:RangeExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param lowerBound The optional inclusive lower bound, or
    /// `null` for the open form (`..hi`).
    /// @param dotDotToken The `..` operator token.
    /// @param upperBound The optional exclusive upper bound, or
    /// `null` for the open form (`lo..`).
    init(
        syntaxTree SyntaxTree,
        lowerBound ExpressionSyntax?,
        dotDotToken SyntaxToken,
        upperBound ExpressionSyntax?
    ) : base(syntaxTree) {
        LowerBound = lowerBound
        DotDotToken = dotDotToken
        UpperBound = upperBound
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.RangeExpression

    /// Gets the inclusive lower bound, or `null` when open.
    prop LowerBound ExpressionSyntax? {
        get;
    }

    /// Gets the `..` operator token.
    prop DotDotToken SyntaxToken {
        get;
    }

    /// Gets the exclusive upper bound, or `null` when open.
    prop UpperBound ExpressionSyntax? {
        get;
    }
}
