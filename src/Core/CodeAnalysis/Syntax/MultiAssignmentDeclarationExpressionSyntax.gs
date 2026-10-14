// <copyright file="MultiAssignmentDeclarationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// A fresh local target inside a multi-assignment, for example
/// `existing, let fresh = Pair()`.
class MultiAssignmentDeclarationExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:MultiAssignmentDeclarationExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `let` or `var` keyword.
    /// @param identifier The declared local identifier.
    init(syntaxTree SyntaxTree, keyword SyntaxToken, identifier SyntaxToken) : base(syntaxTree) {
        Keyword = keyword
        Identifier = identifier
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.MultiAssignmentDeclarationExpression

    /// Gets the `let` or `var` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the declared local identifier.
    prop Identifier SyntaxToken {
        get;
    }
}
