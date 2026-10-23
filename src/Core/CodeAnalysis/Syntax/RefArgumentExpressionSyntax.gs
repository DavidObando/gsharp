// <copyright file="RefArgumentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0060: an argument-position expression wrapped with a `ref`, `out`, or `in`
/// contextual modifier. For `ref`/`in` the inner (cref:Expression) is the
/// lvalue being passed by reference. For `out`, the node optionally carries an
/// inline-declaration payload (`out var name [T]`, `out let name [T]`, or `out _`)
/// recognised via (cref:DeclarationKeyword) / (cref:DiscardToken); in those forms
/// (cref:Expression) is `null`.
partial class RefArgumentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:RefArgumentExpressionSyntax) class for the lvalue
    /// form (`ref expr`, `in expr`, `out expr`).
    /// @param syntaxTree The parent syntax tree.
    /// @param refKindModifier The literal `ref`/`out`/`in` token.
    /// @param expression The lvalue expression being passed by reference.
    init(syntaxTree SyntaxTree, refKindModifier SyntaxToken, expression ExpressionSyntax?) : base(syntaxTree) {
        RefKindModifier = refKindModifier
        Expression = expression
        DeclarationKeyword = nil
        DeclarationIdentifier = nil
        DiscardToken = nil
        DeclaredType = nil
    }

    /// Initializes a new instance of the (cref:RefArgumentExpressionSyntax) class for the inline-
    /// declaration form (`out var name [T]`, `out let name [T]`) or the discard form (`out _`).
    /// @param syntaxTree The parent syntax tree.
    /// @param refKindModifier The `out` token.
    /// @param declarationKeyword The `var` or `let` token (null for `out _`).
    /// @param declarationIdentifier The new local's identifier (null for `out _`).
    /// @param discardToken The `_` token for `out _`; null otherwise.
    /// @param declaredType Optional type clause for the new local (null when omitted).
    init(
        syntaxTree SyntaxTree,
        refKindModifier SyntaxToken,
        declarationKeyword SyntaxToken?,
        declarationIdentifier SyntaxToken?,
        discardToken SyntaxToken?,
        declaredType TypeClauseSyntax?
    ) : base(syntaxTree) {
        RefKindModifier = refKindModifier
        DeclarationKeyword = declarationKeyword
        DeclarationIdentifier = declarationIdentifier
        DiscardToken = discardToken
        DeclaredType = declaredType
        Expression = nil
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.RefArgumentExpression

    /// Gets the literal `ref`, `out`, or `in` contextual-modifier token.
    prop RefKindModifier SyntaxToken {
        get;
    }

    /// Gets the lvalue expression for the plain form, or `null` for the declaration/discard forms.
    prop Expression ExpressionSyntax? {
        get;
    }

    /// Gets the `var` or `let` declaration keyword for `out var/let name`; `null` otherwise.
    prop DeclarationKeyword SyntaxToken? {
        get;
    }

    /// Gets the new local's identifier for `out var/let name`; `null` otherwise.
    prop DeclarationIdentifier SyntaxToken? {
        get;
    }

    /// Gets the underscore token for `out _`; `null` otherwise.
    prop DiscardToken SyntaxToken? {
        get;
    }

    /// Gets the optional type clause for the inline-declared local (`out var name T`).
    prop DeclaredType TypeClauseSyntax? {
        get;
    }

    /// Gets a value indicating whether this argument is an inline-declaration form (`out var/let name` or
    /// `out _`).
    prop IsInlineDeclaration bool -> DeclarationKeyword != nil || DiscardToken != nil

    /// Gets a value indicating whether this argument is the discard form (`out _`).
    prop IsDiscard bool -> DiscardToken != nil
}
