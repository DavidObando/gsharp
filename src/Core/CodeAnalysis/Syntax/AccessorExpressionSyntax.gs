// <copyright file="AccessorExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an accessor expression syntax in the language.
partial class AccessorExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:AccessorExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param leftPart The left part.
    /// @param dotToken The dot token.
    /// @param rightPart The right part.
    init(syntaxTree SyntaxTree, leftPart ExpressionSyntax, dotToken SyntaxToken, rightPart ExpressionSyntax) : base(
        syntaxTree
    ) {
        LeftPart = leftPart
        DotToken = dotToken
        RightPart = rightPart
        IsNullConditional = dotToken.Kind == SyntaxKind.QuestionDotToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AccessorExpression

    /// Gets a value indicating whether this accessor uses the
    /// null-conditional form (`?.`) introduced in Phase 3.C.3b.
    prop IsNullConditional bool {
        get;
    }

    /// Gets the left part.
    prop LeftPart ExpressionSyntax {
        get;
    }

    /// Gets the dot token.
    prop DotToken SyntaxToken {
        get;
    }

    /// Gets the right part.
    prop RightPart ExpressionSyntax {
        get;
    }
}
