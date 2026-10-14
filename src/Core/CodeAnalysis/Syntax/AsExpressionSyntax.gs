// <copyright file="AsExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an expression-level safe cast: `expr as T` → `T` or `null`.
/// Issue #575.
class AsExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:AsExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param expression The expression being cast.
    /// @param asKeyword The `as` keyword token.
    /// @param typeClause The target type clause.
    init(syntaxTree SyntaxTree, expression ExpressionSyntax, asKeyword SyntaxToken, typeClause TypeClauseSyntax) : base(
        syntaxTree
    ) {
        Expression = expression
        AsKeyword = asKeyword
        TypeClause = typeClause
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AsExpression

    /// Gets the left-hand expression being cast.
    prop Expression ExpressionSyntax {
        get;
    }

    /// Gets the `as` keyword token.
    prop AsKeyword SyntaxToken {
        get;
    }

    /// Gets the target type clause.
    prop TypeClause TypeClauseSyntax {
        get;
    }
}
