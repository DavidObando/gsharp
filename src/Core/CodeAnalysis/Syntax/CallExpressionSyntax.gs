// <copyright file="CallExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a call expression syntax in the language.
class CallExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:CallExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The identifier.
    /// @param openParenthesisToken The open parenthesis token.
    /// @param arguments The arguments.
    /// @param closeParenthesisToken The close parenthesis token.
    convenience init(
        syntaxTree SyntaxTree,
        identifier SyntaxToken,
        openParenthesisToken SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesisToken SyntaxToken
    ) {
        init(syntaxTree, identifier, nil, openParenthesisToken, arguments, closeParenthesisToken)
    }

    /// Initializes a new instance of the (cref:CallExpressionSyntax) class with an optional explicit
    /// type-argument list (Phase 4.1 / ADR-0020).
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The identifier.
    /// @param typeArgumentList Optional explicit type-argument list (e.g. `[int]` in `Identity[int](5)`).
    /// @param openParenthesisToken The open parenthesis token.
    /// @param arguments The arguments.
    /// @param closeParenthesisToken The close parenthesis token.
    convenience init(
        syntaxTree SyntaxTree,
        identifier SyntaxToken,
        typeArgumentList TypeArgumentListSyntax?,
        openParenthesisToken SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesisToken SyntaxToken
    ) {
        init(syntaxTree, identifier, nil, typeArgumentList, openParenthesisToken, arguments, closeParenthesisToken)
    }

    /// Initializes a new instance of the (cref:CallExpressionSyntax) class with nullable type-conversion
    /// call support (issue #663).
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The identifier.
    /// @param nullableQuestionToken Optional `?` token indicating the type-conversion
    /// targets the nullable form of the type (e.g. `string?(x)`).
    /// @param typeArgumentList Optional explicit type-argument list.
    /// @param openParenthesisToken The open parenthesis token.
    /// @param arguments The arguments.
    /// @param closeParenthesisToken The close parenthesis token.
    init(
        syntaxTree SyntaxTree,
        identifier SyntaxToken,
        nullableQuestionToken SyntaxToken?,
        typeArgumentList TypeArgumentListSyntax?,
        openParenthesisToken SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesisToken SyntaxToken
    ) : base(syntaxTree) {
        Identifier = identifier
        NullableQuestionToken = nullableQuestionToken
        TypeArgumentList = typeArgumentList
        OpenParenthesisToken = openParenthesisToken
        Arguments = arguments
        CloseParenthesisToken = closeParenthesisToken
    }

    /// Initializes a new instance of the (cref:CallExpressionSyntax) class for an
    /// <em>indirect</em> invocation whose callee is an arbitrary function-typed expression
    /// (issue #2185): `(expr)(args)`, `expr!!(args)`, and any other postfix
    /// `callee(args)` where [`callee`](paramref) is not a bare identifier / member-access
    /// name. The synthetic (cref:Identifier) is an empty token positioned at the callee so
    /// span computation stays monotonic; the binder dispatches on (cref:Callee) being
    /// non-`null` before any identifier-based resolution.
    /// @param syntaxTree The parent syntax tree.
    /// @param callee The expression evaluated to obtain the function value to invoke.
    /// @param openParenthesisToken The open parenthesis token.
    /// @param arguments The arguments.
    /// @param closeParenthesisToken The close parenthesis token.
    convenience init(
        syntaxTree SyntaxTree,
        callee ExpressionSyntax,
        openParenthesisToken SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesisToken SyntaxToken
    ) {
        init(syntaxTree, callee, nil, openParenthesisToken, arguments, closeParenthesisToken)
    }

    /// Initializes a new instance of the (cref:CallExpressionSyntax) class for an
    /// indirect invocation whose arbitrary callee is optionally null-conditionally invoked
    /// (issue #3356): `callee?(args)`.
    /// @param syntaxTree The parent syntax tree.
    /// @param callee The expression evaluated to obtain the function value to invoke.
    /// @param nullableQuestionToken Optional `?` token for null-conditional invocation.
    /// @param openParenthesisToken The open parenthesis token.
    /// @param arguments The arguments.
    /// @param closeParenthesisToken The close parenthesis token.
    init(
        syntaxTree SyntaxTree,
        callee ExpressionSyntax,
        nullableQuestionToken SyntaxToken?,
        openParenthesisToken SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesisToken SyntaxToken
    ) : base(syntaxTree) {
        Callee = callee
        Identifier = SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, callee.Span.Start, string.Empty, nil)
        NullableQuestionToken = nullableQuestionToken
        TypeArgumentList = nil
        OpenParenthesisToken = openParenthesisToken
        Arguments = arguments
        CloseParenthesisToken = closeParenthesisToken
    }

    /// Initializes a new instance of the (cref:CallExpressionSyntax)
    /// class for a conversion call whose target is a composite type clause,
    /// such as `[]object(value)`.
    /// @param syntaxTree The parent syntax tree.
    /// @param conversionTypeClause The conversion target type.
    /// @param openParenthesisToken The open parenthesis token.
    /// @param arguments The arguments.
    /// @param closeParenthesisToken The close parenthesis token.
    init(
        syntaxTree SyntaxTree,
        conversionTypeClause TypeClauseSyntax,
        openParenthesisToken SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesisToken SyntaxToken
    ) : base(syntaxTree) {
        ConversionTypeClause = conversionTypeClause
        Identifier = SyntaxToken(
            syntaxTree,
            SyntaxKind.IdentifierToken,
            conversionTypeClause.Span.Start,
            string.Empty,
            nil
        )
        OpenParenthesisToken = openParenthesisToken
        Arguments = arguments
        CloseParenthesisToken = closeParenthesisToken
    }

    /// Gets the contextual readonly modifier of a persistent address intrinsic.
    prop ReadOnlyManagedModifier SyntaxToken? {
        get;
        internal set;
    }

    /// Gets the callee expression for an indirect invocation (issue #2185), or
    /// `null` for the ordinary identifier / member-access call forms. When
    /// non-`null` the call target is the value produced by evaluating this
    /// expression, which must have a function (or delegate) type.
    prop Callee ExpressionSyntax? {
        get;
    }

    /// Gets the composite conversion target, or `null` for
    /// named calls and indirect invocations.
    prop ConversionTypeClause TypeClauseSyntax? {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.CallExpression

    /// Gets the identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional `?` token preceding the argument list. On a named
    /// call it denotes a nullable-type conversion or direct null-conditional delegate
    /// invocation; on an indirect call it denotes `callee?(args)`.
    prop NullableQuestionToken SyntaxToken? {
        get;
    }

    /// Gets the optional explicit type-argument list `[T1, T2]` attached to this call site (Phase 4.1 /
    /// ADR-0020); `null` when the call has no explicit type arguments.
    prop TypeArgumentList TypeArgumentListSyntax? {
        get;
    }

    /// Gets the open parenthesis token.
    prop OpenParenthesisToken SyntaxToken {
        get;
    }

    /// Gets the arguments.
    prop Arguments SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the close parenthesis token.
    prop CloseParenthesisToken SyntaxToken {
        get;
    }
}
