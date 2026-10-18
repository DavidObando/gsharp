// <copyright file="GuardLetStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `guard let name = expr [, let n2 = e2]* else { else }`
/// statement (ADR-0071 / issue #708). The new bindings extend the enclosing
/// block's scope; the else-block must unconditionally exit the enclosing
/// region (return / throw / break / continue) — see GS0297.
class GuardLetStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:GuardLetStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param guardKeyword The `guard` keyword token.
    /// @param bindings The comma-separated list of `let` bindings.
    /// @param guardOperatorToken The optional `&&` token introducing the guard (null when absent).
    /// @param guard The optional guard expression (null when absent).
    /// @param elseKeyword The `else` keyword token.
    /// @param elseStatement The else-block (must terminate the enclosing scope).
    init(
        syntaxTree SyntaxTree,
        guardKeyword SyntaxToken,
        bindings SeparatedSyntaxList[IfLetBindingClauseSyntax],
        guardOperatorToken SyntaxToken?,
        $guard ExpressionSyntax?,
        elseKeyword SyntaxToken,
        elseStatement StatementSyntax
    ) : base(syntaxTree) {
        GuardKeyword = guardKeyword
        Bindings = bindings
        GuardOperatorToken = guardOperatorToken
        Guard = $guard
        ElseKeyword = elseKeyword
        ElseStatement = elseStatement
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.GuardLetStatement

    /// Gets the `guard` keyword token.
    prop GuardKeyword SyntaxToken {
        get;
    }

    /// Gets the comma-separated list of bindings.
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
    /// when absent. `guard let` does not support a guard;
    /// the parser reports GS0625 when one is present and the binder ignores it.
    prop Guard ExpressionSyntax? {
        get;
    }

    /// Gets the `else` keyword token.
    prop ElseKeyword SyntaxToken {
        get;
    }

    /// Gets the else-block; required and must unconditionally exit the enclosing scope.
    prop ElseStatement StatementSyntax {
        get;
    }
}
