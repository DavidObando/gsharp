// <copyright file="ConstructorDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text

/// Issue #306: represents a standalone user-defined constructor declared inside a
/// `class` body via the `init(params) [: base(args)] { ... }` form. Unlike
/// the Kotlin-style primary constructor (which only declares same-named fields and
/// implicitly chains to a parameterless base ctor), an `init` constructor has an
/// explicit body of statements and may chain to a specific base constructor.
partial class ConstructorDeclarationSyntax : MemberSyntax {
    /// Initializes a new instance of the (cref:ConstructorDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier (`public`/`internal`/`private`).
    /// @param convenienceModifier The optional ADR-0065 §2 `convenience` modifier, or `null`.
    /// @param initKeyword The contextual `init` keyword that introduces the constructor.
    /// @param openParenthesisToken The opening paren of the parameter list.
    /// @param parameters The constructor parameters.
    /// @param closeParenthesisToken The closing paren of the parameter list.
    /// @param baseColonToken The optional `:` introducing a base initializer, or `null`.
    /// @param baseKeyword The optional contextual `base` keyword, or `null`.
    /// @param baseOpenParenthesisToken The optional opening paren of the base argument list, or `null`.
    /// @param baseArguments The base-constructor argument expressions (empty when no base initializer).
    /// @param baseCloseParenthesisToken The optional closing paren of the base argument list, or `null`.
    /// @param body The constructor body block.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        convenienceModifier SyntaxToken?,
        initKeyword SyntaxToken,
        openParenthesisToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenthesisToken SyntaxToken,
        baseColonToken SyntaxToken?,
        baseKeyword SyntaxToken?,
        baseOpenParenthesisToken SyntaxToken?,
        baseArguments SeparatedSyntaxList[ExpressionSyntax],
        baseCloseParenthesisToken SyntaxToken?,
        body BlockStatementSyntax
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        ConvenienceModifier = convenienceModifier
        InitKeyword = initKeyword
        OpenParenthesisToken = openParenthesisToken
        Parameters = parameters
        CloseParenthesisToken = closeParenthesisToken
        BaseColonToken = baseColonToken
        BaseKeyword = baseKeyword
        BaseOpenParenthesisToken = baseOpenParenthesisToken
        BaseArguments = baseArguments
        BaseCloseParenthesisToken = baseCloseParenthesisToken
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ConstructorDeclaration

    /// Gets the optional accessibility modifier.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the optional ADR-0065 §2 `convenience` modifier, or `null`.
    prop ConvenienceModifier SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this constructor is declared with the `convenience` modifier
    /// (ADR-0065 §2).
    prop IsConvenience bool -> ConvenienceModifier != nil

    /// Gets the contextual `init` keyword.
    prop InitKeyword SyntaxToken {
        get;
    }

    /// Gets the opening paren of the parameter list.
    prop OpenParenthesisToken SyntaxToken {
        get;
    }

    /// Gets the constructor parameters.
    prop Parameters SeparatedSyntaxList[ParameterSyntax] {
        get;
    }

    /// Gets the closing paren of the parameter list.
    prop CloseParenthesisToken SyntaxToken {
        get;
    }

    /// Gets the optional `:` introducing the base initializer.
    prop BaseColonToken SyntaxToken? {
        get;
    }

    /// Gets the optional contextual `base` keyword.
    prop BaseKeyword SyntaxToken? {
        get;
    }

    /// Gets the optional opening paren of the base argument list.
    prop BaseOpenParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the base-constructor argument expressions (empty when no base initializer).
    prop BaseArguments SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the optional closing paren of the base argument list.
    prop BaseCloseParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the constructor body block.
    prop Body BlockStatementSyntax {
        get;
    }

    /// Gets a value indicating whether this constructor declares an explicit `: base(args)` initializer.
    prop HasBaseInitializer bool -> BaseKeyword != nil

    /// @remarks The span starts at the ACCESSIBILITY MODIFIER when there is one. It used to
    /// start at `convenience`/`init`, which left `private` outside the
    /// declaration it introduces -- and a declaration whose span excludes its own
    /// modifiers is not merely imprecise, it is wrong in two places that both read
    /// `Span.Start` as "where this declaration begins":
    /// (cref:DocumentationAttacher) requires a documented declaration to start
    /// on the line after the `///` block, and the ADR-0179 formatter puts its
    /// member break before that same position. Together those produced
    /// `private` on its own line, a blank line, then `init` -- and GS0227
    /// "documentation comment is not attached to a declaration" on the migrated tree.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Span TextSpan -> TextSpan.FromBounds(
        (AccessibilityModifier ?? ConvenienceModifier ?? InitKeyword).Span.Start,
        Body.Span.End
    )

    /// Gets a value that tells that this node takes its span from an override, not from its children.
    internal override prop SpanFromChildren bool -> false
}
