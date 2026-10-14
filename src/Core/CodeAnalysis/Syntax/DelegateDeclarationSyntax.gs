// <copyright file="DelegateDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a named delegate type declaration
/// `delegate Name[TParams]?(params...) ReturnType? ;` (issue #3510;
/// originally ADR-0059 / issue #255 with the retired
/// `type Name = delegate func(...)` spelling, which now parses only as
/// an error-recovery form). Unlike an erased type alias, this declaration
/// emits a real CLR TypeDef deriving from `System.MulticastDelegate`.
/// The required trailing semicolon terminates the optional return-type
/// clause, matching extern natives and interface bodiless members.
class DelegateDeclarationSyntax : MemberSyntax {
    /// Initializes a new instance of the (cref:DelegateDeclarationSyntax) class
    /// for the canonical `delegate Name(params) R;` form (issue #3510).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier (`public`, `internal`, `private`).
    /// @param delegateKeyword The contextual `delegate` identifier token opening the declaration.
    /// @param identifier The delegate type name.
    /// @param typeParameterList Optional generic type-parameter list (`[T any]`).
    /// @param openParenToken The `(` token opening the parameter list.
    /// @param parameters The (possibly empty) parameter list.
    /// @param closeParenToken The `)` token closing the parameter list.
    /// @param returnType Optional return type clause; `null` for void.
    /// @param semicolonToken The required terminating `;` token.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        delegateKeyword SyntaxToken,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        openParenToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenToken SyntaxToken,
        returnType TypeClauseSyntax?,
        semicolonToken SyntaxToken
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        DelegateKeyword = delegateKeyword
        Identifier = identifier
        TypeParameterList = typeParameterList
        OpenParenToken = openParenToken
        Parameters = parameters
        CloseParenToken = closeParenToken
        ReturnType = returnType
        SemicolonToken = semicolonToken
    }

    /// Initializes a new instance of the (cref:DelegateDeclarationSyntax) class
    /// for the RETIRED `type Name = delegate func(...)` recovery form
    /// (issue #3510 — the parser reports the migration diagnostic and keeps
    /// binding through this node so downstream sees one clean error).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier (`public`, `internal`, `private`).
    /// @param typeKeyword The legacy `type` token that opened the declaration.
    /// @param identifier The delegate type name.
    /// @param typeParameterList Optional generic type-parameter list (`[T any]`).
    /// @param equalsToken The legacy `=` token.
    /// @param delegateKeyword The contextual `delegate` identifier token.
    /// @param funcKeyword The legacy `func` keyword.
    /// @param openParenToken The `(` token opening the parameter list.
    /// @param parameters The (possibly empty) parameter list.
    /// @param closeParenToken The `)` token closing the parameter list.
    /// @param returnType Optional return type clause; `null` for void.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        equalsToken SyntaxToken,
        delegateKeyword SyntaxToken,
        funcKeyword SyntaxToken,
        openParenToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenToken SyntaxToken,
        returnType TypeClauseSyntax?
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        TypeKeyword = typeKeyword
        Identifier = identifier
        TypeParameterList = typeParameterList
        EqualsToken = equalsToken
        DelegateKeyword = delegateKeyword
        FuncKeyword = funcKeyword
        OpenParenToken = openParenToken
        Parameters = parameters
        CloseParenToken = closeParenToken
        ReturnType = returnType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.DelegateDeclaration

    /// Gets the optional accessibility modifier token.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the legacy `type` token (retired-form recovery only; issue #3510).
    prop TypeKeyword SyntaxToken? {
        get;
    }

    /// Gets the delegate type identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional generic type-parameter list.
    prop TypeParameterList TypeParameterListSyntax? {
        get;
    }

    /// Gets the legacy `=` token (retired-form recovery only; issue #3510).
    prop EqualsToken SyntaxToken? {
        get;
    }

    /// Gets the contextual `delegate` identifier token.
    prop DelegateKeyword SyntaxToken {
        get;
    }

    /// Gets the legacy `func` keyword (retired-form recovery only; issue #3510).
    prop FuncKeyword SyntaxToken? {
        get;
    }

    /// Gets the required terminating `;` token of the canonical form (issue #3510); `null` on the
    /// retired-form recovery node.
    prop SemicolonToken SyntaxToken? {
        get;
    }

    /// Gets the opening parenthesis token.
    prop OpenParenToken SyntaxToken {
        get;
    }

    /// Gets the parameter list (may be empty).
    prop Parameters SeparatedSyntaxList[ParameterSyntax] {
        get;
    }

    /// Gets the closing parenthesis token.
    prop CloseParenToken SyntaxToken {
        get;
    }

    /// Gets the optional return type clause; `null` for a `void`-returning delegate.
    prop ReturnType TypeClauseSyntax? {
        get;
    }
}
