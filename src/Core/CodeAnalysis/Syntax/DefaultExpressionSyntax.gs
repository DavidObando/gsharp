// <copyright file="DefaultExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0100 / issue #795: a `default(T)` or bare `default`
/// expression. The two forms are surfaced by the same node so downstream
/// code only sees one syntax kind: (cref:TypeClause) is non-null
/// for `default(T)` and null for the bare literal.
/// @remarks The `default` keyword's existing role as a switch-arm leader is
/// preserved. (cref:Parser) matches arm-leading `default`
/// inside `ParseSwitchCase`, `ParseSelectCase`, and
/// `ParseSwitchExpressionArm` before any expression dispatch, so
/// this expression node only fires for true value-position uses.
partial class DefaultExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:DefaultExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param defaultKeyword The `default` keyword token.
    /// @param openParenthesis The `(` token, or `null` for bare `default`.
    /// @param typeClause The type clause inside the parentheses, or `null` for bare `default`.
    /// @param closeParenthesis The `)` token, or `null` for bare `default`.
    init(
        syntaxTree SyntaxTree,
        defaultKeyword SyntaxToken,
        openParenthesis SyntaxToken?,
        typeClause TypeClauseSyntax?,
        closeParenthesis SyntaxToken?
    ) : base(syntaxTree) {
        DefaultKeyword = defaultKeyword
        OpenParenthesis = openParenthesis
        TypeClause = typeClause
        CloseParenthesis = closeParenthesis
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.DefaultExpression

    /// Gets the `default` keyword token.
    prop DefaultKeyword SyntaxToken {
        get;
    }

    /// Gets the opening `(` token, or `null` for the bare form.
    prop OpenParenthesis SyntaxToken? {
        get;
    }

    /// Gets the type clause argument, or `null` for the bare form.
    prop TypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the closing `)` token, or `null` for the bare form.
    prop CloseParenthesis SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this is the parenthesized
    /// `default(T)` form (with an explicit type clause) rather than
    /// the bare `default` literal.
    prop HasTypeClause bool -> TypeClause != nil
}
