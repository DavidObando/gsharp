// <copyright file="IfLetExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0151: an `if let` expression in value position —
/// `if let name = expr [, let n2 = e2]* [&& guard] { value } else { value }`.
/// It combines the nullable-binding header of the ADR-0071 `if let`
/// STATEMENT (the binding list is the very same
/// (cref:IfLetBindingClauseSyntax) list) with the value-producing
/// branch shape of the ADR-0064 if-EXPRESSION. The binder lowers it into the
/// existing `BoundBlockExpression` / `BoundConditionalExpression`
/// pair, so no new bound-node kind or backend path is introduced.
class IfLetExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:IfLetExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param ifKeyword The `if` keyword token.
    /// @param bindings The comma-separated list of `let` bindings.
    /// @param guardOperatorToken The optional `&&` token that introduces the guard (null when absent).
    /// @param guard The optional guard expression (null when absent).
    /// @param thenBlock The then-block expression.
    /// @param elseKeyword The `else` keyword token (null only in erroneous source).
    /// @param elseExpression The else branch: a (cref:BlockExpressionSyntax), an (cref:IfExpressionSyntax),
    /// or a nested (cref:IfLetExpressionSyntax) (null only in erroneous source).
    init(
        syntaxTree SyntaxTree,
        ifKeyword SyntaxToken,
        bindings SeparatedSyntaxList[IfLetBindingClauseSyntax],
        guardOperatorToken SyntaxToken?,
        $guard ExpressionSyntax?,
        thenBlock BlockExpressionSyntax,
        elseKeyword SyntaxToken?,
        elseExpression ExpressionSyntax?
    ) : base(syntaxTree) {
        IfKeyword = ifKeyword
        Bindings = bindings
        GuardOperatorToken = guardOperatorToken
        Guard = $guard
        ThenBlock = thenBlock
        ElseKeyword = elseKeyword
        ElseExpression = elseExpression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IfLetExpression

    /// Gets the `if` keyword token.
    prop IfKeyword SyntaxToken {
        get;
    }

    /// Gets the comma-separated list of bindings.
    prop Bindings SeparatedSyntaxList[IfLetBindingClauseSyntax] {
        get;
    }

    /// Gets the optional `&&` token introducing the guard; `null` when there
    /// is no guard. In erroneous source it may be a `||` token (reported as
    /// GS0626 by the parser). Issue #4961 / ADR-0200: named like the statement
    /// forms' (cref:IfLetStatementSyntax.GuardOperatorToken).
    prop GuardOperatorToken SyntaxToken? {
        get;
    }

    /// Gets the optional guard expression evaluated after every binding
    /// succeeded (with all bound names in scope); `null` when absent.
    prop Guard ExpressionSyntax? {
        get;
    }

    /// Gets the then-block expression.
    prop ThenBlock BlockExpressionSyntax {
        get;
    }

    /// Gets the `else` keyword token; `null` only when the source omitted it.
    prop ElseKeyword SyntaxToken? {
        get;
    }

    /// Gets the else branch: a (cref:BlockExpressionSyntax) for a plain
    /// else, or another (cref:IfExpressionSyntax) /
    /// (cref:IfLetExpressionSyntax) for an `else if` chain.
    /// `null` only when the source omitted the else branch (GS0276).
    prop ElseExpression ExpressionSyntax? {
        get;
    }
}
