// <copyright file="CheckedExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the built-in `checked(expr)` / `unchecked(expr)`
/// operator (issue #1881). `checked`/`unchecked` are recognized as
/// contextual identifiers when immediately followed by `(`. Inside
/// `checked(expr)`, integral `+`/`-`/`*` and narrowing
/// numeric conversions trap on overflow (throwing
/// (cref:System.OverflowException)) instead of truncating;
/// `unchecked(expr)` restores the (default) truncating behavior. Nesting
/// is lexical — the innermost `checked`/`unchecked` wins.
partial class CheckedExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:CheckedExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `checked` or `unchecked` identifier token.
    /// @param openParenthesis The `(` token.
    /// @param expression The wrapped expression argument.
    /// @param closeParenthesis The `)` token.
    /// @param isChecked Whether the keyword was `checked` (true) or `unchecked` (false).
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        openParenthesis SyntaxToken,
        expression ExpressionSyntax,
        closeParenthesis SyntaxToken,
        isChecked bool
    ) : base(syntaxTree) {
        Keyword = keyword
        OpenParenthesis = openParenthesis
        Expression = expression
        CloseParenthesis = closeParenthesis
        IsChecked = isChecked
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> if IsChecked {
        SyntaxKind.CheckedExpression
    } else {
        SyntaxKind.UncheckedExpression
    }

    /// Gets the `checked` or `unchecked` identifier token.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the opening `(` token.
    prop OpenParenthesis SyntaxToken {
        get;
    }

    /// Gets the wrapped expression argument.
    prop Expression ExpressionSyntax {
        get;
    }

    /// Gets the closing `)` token.
    prop CloseParenthesis SyntaxToken {
        get;
    }

    /// Gets a value indicating whether the keyword was `checked` (true) or `unchecked` (false).
    prop IsChecked bool {
        get;
    }
}
