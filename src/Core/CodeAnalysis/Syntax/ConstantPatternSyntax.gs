// <copyright file="ConstantPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a constant pattern wrapping the legacy case expression form.
partial class ConstantPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:ConstantPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param expression The constant expression.
    init(syntaxTree SyntaxTree, expression ExpressionSyntax) : base(syntaxTree) {
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ConstantPattern

    /// Gets the constant expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
