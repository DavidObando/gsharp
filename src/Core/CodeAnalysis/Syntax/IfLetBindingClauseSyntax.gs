// <copyright file="IfLetBindingClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// One `let name [T] = expr` clause inside an
/// (cref:IfLetStatementSyntax), (cref:GuardLetStatementSyntax),
/// or (cref:WhileLetStatementSyntax) header (ADR-0071 / ADR-0163).
class IfLetBindingClauseSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:IfLetBindingClauseSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param letKeyword The `let` keyword token.
    /// @param identifier The identifier the binding introduces.
    /// @param typeClause The optional declared (underlying, non-null) type.
    /// @param equalsToken The `=` token.
    /// @param initializer The right-hand-side initializer expression.
    init(
        syntaxTree SyntaxTree,
        letKeyword SyntaxToken,
        identifier SyntaxToken,
        typeClause TypeClauseSyntax?,
        equalsToken SyntaxToken,
        initializer ExpressionSyntax
    ) : base(syntaxTree) {
        LetKeyword = letKeyword
        Identifier = identifier
        TypeClause = typeClause
        EqualsToken = equalsToken
        Initializer = initializer
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IfLetBindingClause

    /// Gets the `let` keyword token.
    prop LetKeyword SyntaxToken {
        get;
    }

    /// Gets the identifier the binding introduces.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional declared (underlying, non-null) type clause.
    prop TypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the `=` token between the identifier (or type clause) and the initializer.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the right-hand-side initializer expression.
    prop Initializer ExpressionSyntax {
        get;
    }
}
