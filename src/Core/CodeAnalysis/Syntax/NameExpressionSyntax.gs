// <copyright file="NameExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a name expression in the language.
open class NameExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:NameExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifierToken The identifier.
    init(syntaxTree SyntaxTree, identifierToken SyntaxToken) : base(syntaxTree) {
        IdentifierToken = identifierToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SyntaxKind -> SyntaxKind.NameExpression

    /// Gets the identifier.
    prop IdentifierToken SyntaxToken {
        get;
    }
}
