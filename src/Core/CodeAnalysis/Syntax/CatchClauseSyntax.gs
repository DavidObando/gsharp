// <copyright file="CatchClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a catch clause attached to a (cref:TryStatementSyntax).
/// ADR-0177 gives the clause C# parity, so four shapes are legal:
/// `catch (e Type)` (typed and bound), `catch (Type)` (typed,
/// unbound), `catch` (catch-all, unbound), and any of those followed by a
/// `when` filter. The pre-ADR-0177 untyped `catch (name)` form is
/// retired: a parenthesized single identifier now names a type, not a binder.
partial class CatchClauseSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:CatchClauseSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param catchKeyword The `catch` keyword.
    /// @param openParenthesisToken The opening parenthesis token; `null` for a bare `catch`.
    /// @param identifier The bound variable identifier; `null` when the clause is unbound.
    /// @param typeClause The exception type clause; `null` for a bare `catch`.
    /// @param closeParenthesisToken The closing parenthesis token; `null` for a bare `catch`.
    /// @param whenKeyword The contextual `when` keyword; `null` when the clause has no filter.
    /// @param filter The filter expression; `null` when the clause has no filter.
    /// @param body The handler block.
    init(
        syntaxTree SyntaxTree,
        catchKeyword SyntaxToken,
        openParenthesisToken SyntaxToken?,
        identifier SyntaxToken?,
        typeClause TypeClauseSyntax?,
        closeParenthesisToken SyntaxToken?,
        whenKeyword SyntaxToken?,
        filter ExpressionSyntax?,
        body BlockStatementSyntax
    ) : base(syntaxTree) {
        CatchKeyword = catchKeyword
        OpenParenthesisToken = openParenthesisToken
        Identifier = identifier
        TypeClause = typeClause
        CloseParenthesisToken = closeParenthesisToken
        WhenKeyword = whenKeyword
        Filter = filter
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.CatchClause

    /// Gets the `catch` keyword.
    prop CatchKeyword SyntaxToken {
        get;
    }

    /// Gets the opening parenthesis token; `null` for a bare `catch`.
    prop OpenParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the bound variable identifier; `null` when the clause is unbound.
    prop Identifier SyntaxToken? {
        get;
    }

    /// Gets the exception type clause; `null` for a bare `catch`, which catches `System.Exception`.
    prop TypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the closing parenthesis token; `null` for a bare `catch`.
    prop CloseParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the contextual `when` keyword; `null` when the clause has no filter.
    prop WhenKeyword SyntaxToken? {
        get;
    }

    /// Gets the filter expression evaluated in the CLR's first pass; `null` when the clause has no filter.
    prop Filter ExpressionSyntax? {
        get;
    }

    /// Gets the handler block.
    prop Body BlockStatementSyntax {
        get;
    }
}
