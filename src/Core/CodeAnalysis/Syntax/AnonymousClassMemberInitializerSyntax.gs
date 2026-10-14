// <copyright file="AnonymousClassMemberInitializerSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a single field member inside an anonymous-object literal
/// (ADR-0146, issue #2243), e.g. the `let Name = "David"` or
/// `let Flag bool = true` in `object { let Name = "David" }`.
/// Modeled on an ordinary `let`/`var` local declaration's grammar
/// ((cref:VariableDeclarationSyntax)): the type clause is now
/// <em>optional</em> — when omitted the member's type is inferred from its
/// initializer expression exactly like an ordinary `let x = expr`
/// declaration.
class AnonymousClassMemberInitializerSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:AnonymousClassMemberInitializerSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param letOrVarKeyword The `let` or `var` keyword.
    /// @param identifier The member name.
    /// @param typeClause The optional member type clause (inferred when null).
    /// @param equalsToken The member/value separator.
    /// @param value The value expression.
    init(
        syntaxTree SyntaxTree,
        letOrVarKeyword SyntaxToken,
        identifier SyntaxToken,
        typeClause TypeClauseSyntax?,
        equalsToken SyntaxToken,
        value ExpressionSyntax
    ) : base(syntaxTree) {
        LetOrVarKeyword = letOrVarKeyword
        Identifier = identifier
        TypeClause = typeClause
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AnonymousClassMemberInitializer

    /// Gets the `let` or `var` keyword.
    prop LetOrVarKeyword SyntaxToken? {
        get;
    }

    /// Gets the member identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional member type clause. Null when the type is inferred from (cref:Value).
    prop TypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the member/value separator token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the value expression.
    prop Value ExpressionSyntax {
        get;
    }

    /// Gets a value indicating whether this member was declared read-only (`let`).
    prop IsReadOnly bool -> LetOrVarKeyword != nil && LetOrVarKeyword!!.Kind == SyntaxKind.LetKeyword
}
