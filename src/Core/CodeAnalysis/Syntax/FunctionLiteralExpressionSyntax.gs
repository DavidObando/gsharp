// <copyright file="FunctionLiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// A function literal expression `func(p1 T1, p2 T2) R { body }`
/// (Phase 4.7). Same shape as a function declaration but without a name,
/// receiver, or modifiers; produces a first-class function value.
/// Optionally preceded by `async` (Phase 5.1+).
class FunctionLiteralExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:FunctionLiteralExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param funcKeyword The `func` keyword token.
    /// @param openParenToken The opening `(`.
    /// @param parameters The parameter list.
    /// @param closeParenToken The closing `)`.
    /// @param returnTypeClause The optional return-type clause.
    /// @param body The function body.
    convenience init(
        syntaxTree SyntaxTree,
        funcKeyword SyntaxToken,
        openParenToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenToken SyntaxToken,
        returnTypeClause TypeClauseSyntax?,
        body BlockStatementSyntax
    ) {
        init(
            syntaxTree,
            nil,
            funcKeyword,
            openParenToken,
            parameters,
            closeParenToken,
            returnTypeClause,
            body,
            nil,
            nil
        )
    }

    /// Initializes a new instance of the (cref:FunctionLiteralExpressionSyntax) class with an optional
    /// `async` modifier.
    /// @param syntaxTree The parent syntax tree.
    /// @param asyncModifier Optional `async` modifier token.
    /// @param funcKeyword The `func` keyword token.
    /// @param openParenToken The opening `(`.
    /// @param parameters The parameter list.
    /// @param closeParenToken The closing `)`.
    /// @param returnTypeClause The optional return-type clause.
    /// @param body The function body.
    /// @param returnRefModifier Issue #4219 (umbrella remainder): the optional `ref` return modifier
    /// preceding [`returnTypeClause`](paramref).
    /// @param returnReadOnlyModifier The optional `readonly` token following
    /// [`returnRefModifier`](paramref).
    init(
        syntaxTree SyntaxTree,
        asyncModifier SyntaxToken?,
        funcKeyword SyntaxToken,
        openParenToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenToken SyntaxToken,
        returnTypeClause TypeClauseSyntax?,
        body BlockStatementSyntax,
        returnRefModifier SyntaxToken? = nil,
        returnReadOnlyModifier SyntaxToken? = nil
    ) : base(syntaxTree) {
        AsyncModifier = asyncModifier
        FuncKeyword = funcKeyword
        OpenParenToken = openParenToken
        Parameters = parameters
        CloseParenToken = closeParenToken
        ReturnRefModifier = returnRefModifier
        ReturnReadOnlyModifier = returnReadOnlyModifier
        ReturnTypeClause = returnTypeClause
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FunctionLiteralExpression

    /// Gets the optional `async` modifier token.
    prop AsyncModifier SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this function literal is async.
    prop IsAsync bool -> AsyncModifier != nil

    /// Gets the `func` keyword token.
    prop FuncKeyword SyntaxToken {
        get;
    }

    /// Gets the opening parenthesis token.
    prop OpenParenToken SyntaxToken {
        get;
    }

    /// Gets the parameter list.
    prop Parameters SeparatedSyntaxList[ParameterSyntax] {
        get;
    }

    /// Gets the closing parenthesis token.
    prop CloseParenToken SyntaxToken {
        get;
    }

    /// Gets the optional `ref` return modifier (issue #4219 umbrella
    /// remainder), mirroring (cref:FunctionDeclarationSyntax.ReturnRefModifier)
    /// for a function LITERAL: `func (...) ref T { ... }`.
    prop ReturnRefModifier SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this literal declares a by-ref return.
    prop IsRefReturn bool -> ReturnRefModifier != nil

    /// Gets the optional `readonly` token following (cref:ReturnRefModifier) (`ref readonly`).
    prop ReturnReadOnlyModifier SyntaxToken? {
        get;
    }

    /// Gets the optional return-type clause.
    prop ReturnTypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the function body.
    prop Body BlockStatementSyntax {
        get;
    }
}
