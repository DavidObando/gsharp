// <copyright file="WhileLetStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `while let name = expr [, let n2 = e2]* { body }`
/// statement (ADR-0163 / issue #3352).
/// @remarks Each initializer is re-evaluated before every iteration. The bindings are
/// visible only inside (cref:Body) and are observed there at their
/// underlying non-null types.
partial class WhileLetStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:WhileLetStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param whileKeyword The `while` keyword token.
    /// @param bindings The comma-separated `let` bindings.
    /// @param guardOperatorToken The optional `&&` token introducing the guard (null when absent).
    /// @param guard The optional guard expression (null when absent).
    /// @param body The loop body.
    init(
        syntaxTree SyntaxTree,
        whileKeyword SyntaxToken,
        bindings SeparatedSyntaxList[IfLetBindingClauseSyntax],
        guardOperatorToken SyntaxToken?,
        $guard ExpressionSyntax?,
        body StatementSyntax
    ) : base(syntaxTree) {
        WhileKeyword = whileKeyword
        Bindings = bindings
        GuardOperatorToken = guardOperatorToken
        Guard = $guard
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.WhileLetStatement

    /// Gets the `while` keyword token.
    prop WhileKeyword SyntaxToken {
        get;
    }

    /// Gets the comma-separated binding list.
    prop Bindings SeparatedSyntaxList[IfLetBindingClauseSyntax] {
        get;
    }

    /// Issue #4961 / ADR-0201: gets the optional `&&` token introducing the
    /// guard; `null` when there is no guard. In erroneous source it may be a
    /// `||` token (reported as GS0626 by the parser).
    prop GuardOperatorToken SyntaxToken? {
        get;
    }

    /// Issue #4961 / ADR-0201: gets the optional guard expression; `null`
    /// when absent. `while let` does not support a guard;
    /// the parser reports GS0625 when one is present and the binder ignores it.
    prop Guard ExpressionSyntax? {
        get;
    }

    /// Gets the loop body.
    prop Body StatementSyntax {
        get;
    }
}
