// <copyright file="BaseClassCallExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the canonical non-virtual base-class call `base.Method(args)`.
partial class BaseClassCallExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:BaseClassCallExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param baseKeyword The contextual `base` token.
    /// @param dotToken The member-access dot.
    /// @param call The method call following the dot.
    init(syntaxTree SyntaxTree, baseKeyword SyntaxToken, dotToken SyntaxToken, call CallExpressionSyntax) : base(
        syntaxTree
    ) {
        BaseKeyword = baseKeyword
        DotToken = dotToken
        Call = call
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.BaseClassCallExpression

    /// Gets the contextual `base` token.
    prop BaseKeyword SyntaxToken {
        get;
    }

    /// Gets the member-access dot.
    prop DotToken SyntaxToken {
        get;
    }

    /// Gets the method call following the dot.
    prop Call CallExpressionSyntax {
        get;
    }
}
