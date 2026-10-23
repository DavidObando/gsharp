// <copyright file="BaseInterfaceCallExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// ADR-0091 / issue #757: explicit-base interface call expression of the
/// form `base[IFoo].Method(args)`. Disambiguates between inherited
/// default interface method (DIM) bodies in a diamond and lets an
/// override delegate to a specific inherited default. The parser commits
/// to this shape when an identifier whose text is `"base"` is
/// immediately followed by `[`.
partial class BaseInterfaceCallExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:BaseInterfaceCallExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param baseKeyword The contextual `base` identifier token.
    /// @param openBracketToken The opening `[` token.
    /// @param interfaceTypeClause The interface type clause inside the brackets.
    /// @param closeBracketToken The closing `]` token.
    /// @param dotToken The `.` token between the bracketed interface selector and the method name.
    /// @param methodIdentifier The method identifier token.
    /// @param methodTypeArgumentList Optional generic method type arguments (reserved; rejected by the
    /// binder in this PR).
    /// @param openParenthesisToken The opening `(` token.
    /// @param arguments The argument list.
    /// @param closeParenthesisToken The closing `)` token.
    init(
        syntaxTree SyntaxTree,
        baseKeyword SyntaxToken,
        openBracketToken SyntaxToken,
        interfaceTypeClause TypeClauseSyntax,
        closeBracketToken SyntaxToken,
        dotToken SyntaxToken,
        methodIdentifier SyntaxToken,
        methodTypeArgumentList TypeArgumentListSyntax?,
        openParenthesisToken SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesisToken SyntaxToken
    ) : base(syntaxTree) {
        BaseKeyword = baseKeyword
        OpenBracketToken = openBracketToken
        InterfaceTypeClause = interfaceTypeClause
        CloseBracketToken = closeBracketToken
        DotToken = dotToken
        MethodIdentifier = methodIdentifier
        MethodTypeArgumentList = methodTypeArgumentList
        OpenParenthesisToken = openParenthesisToken
        Arguments = arguments
        CloseParenthesisToken = closeParenthesisToken
    }

    /// Initializes a new instance of the (cref:BaseInterfaceCallExpressionSyntax) class
    /// in the parenthesis-less PROPERTY form `base[BaseClass].Prop` (read) or
    /// `base[BaseClass].Prop = value` (write). Issue #1104: this mirrors the
    /// plain `base.Prop` access but with an explicit ancestor selector, so the
    /// binder routes it through the base-class property read/write path. The
    /// call-only members ((cref:OpenParenthesisToken),
    /// (cref:Arguments), (cref:CloseParenthesisToken)) are left
    /// `null`/empty; (cref:IsPropertyAccess) reports this form.
    /// @param syntaxTree The parent syntax tree.
    /// @param baseKeyword The contextual `base` identifier token.
    /// @param openBracketToken The opening `[` token.
    /// @param interfaceTypeClause The base-class type clause inside the brackets.
    /// @param closeBracketToken The closing `]` token.
    /// @param dotToken The `.` token between the bracketed selector and the property name.
    /// @param memberIdentifier The property identifier token.
    /// @param equalsToken The `=` token for the write form, or `null` for a read.
    /// @param value The assigned value expression for the write form, or `null` for a read.
    init(
        syntaxTree SyntaxTree,
        baseKeyword SyntaxToken,
        openBracketToken SyntaxToken,
        interfaceTypeClause TypeClauseSyntax,
        closeBracketToken SyntaxToken,
        dotToken SyntaxToken,
        memberIdentifier SyntaxToken,
        equalsToken SyntaxToken?,
        value ExpressionSyntax?
    ) : base(syntaxTree) {
        BaseKeyword = baseKeyword
        OpenBracketToken = openBracketToken
        InterfaceTypeClause = interfaceTypeClause
        CloseBracketToken = closeBracketToken
        DotToken = dotToken
        MethodIdentifier = memberIdentifier
        MethodTypeArgumentList = nil
        OpenParenthesisToken = nil
        Arguments = SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty)
        CloseParenthesisToken = nil
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.BaseInterfaceCallExpression

    /// Gets a value indicating whether this is the parenthesis-less PROPERTY form
    /// (`base[BaseClass].Prop`) rather than the method-CALL form
    /// (`base[IFoo].M(args)`). Determined by the absence of the opening `(`.
    prop IsPropertyAccess bool -> OpenParenthesisToken == nil

    /// Gets a value indicating whether this property form is a WRITE
    /// (`base[BaseClass].Prop = value`) rather than a READ. Only meaningful
    /// when (cref:IsPropertyAccess) is `true`.
    prop IsPropertyWrite bool -> Value != nil

    /// Gets the contextual `base` identifier token.
    prop BaseKeyword SyntaxToken {
        get;
    }

    /// Gets the opening `[` token.
    prop OpenBracketToken SyntaxToken {
        get;
    }

    /// Gets the interface selector type clause appearing inside `base[...]`.
    prop InterfaceTypeClause TypeClauseSyntax {
        get;
    }

    /// Gets the closing `]` token.
    prop CloseBracketToken SyntaxToken {
        get;
    }

    /// Gets the `.` token between the bracketed interface and the method name.
    prop DotToken SyntaxToken {
        get;
    }

    /// Gets the method identifier token (the `M` in `base[IFoo].M(...)`).
    prop MethodIdentifier SyntaxToken {
        get;
    }

    /// Gets the optional generic method type arguments list (e.g. `[int]` in `base[IFoo].Map[int](...)`).
    /// Reserved for a future extension; the binder rejects a non-null list in this PR.
    prop MethodTypeArgumentList TypeArgumentListSyntax? {
        get;
    }

    /// Gets the opening `(` token, or `null` for the property-assignment
    /// form (`base[IFace].Member = value`), which has no argument list.
    prop OpenParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the argument list.
    prop Arguments SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the closing `)` token, or `null` for the property-assignment
    /// form (`base[IFace].Member = value`), which has no argument list.
    prop CloseParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the `=` token for the property WRITE form (`base[Base].Prop = value`), or `null` for a read or
    /// the call form.
    prop EqualsToken SyntaxToken? {
        get;
    }

    /// Gets the assigned value expression for the property WRITE form, or `null` for a read or the call
    /// form.
    prop Value ExpressionSyntax? {
        get;
    }
}
