// <copyright file="IfExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #669: an if-expression of the form
/// `if cond { expr } else { expr }` (value-producing) or
/// `if cond { expr } else if ... { expr } else { expr }` (chained).
/// Issue #4962: like the if-statement, the header may start with a
/// simple-statement initializer, `if init; cond { … } else { … }`.
/// The else branch is either another (cref:IfExpressionSyntax) (for
/// `else if` chains) or a (cref:BlockExpressionSyntax).
class IfExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:IfExpressionSyntax) class
    /// without an initializer.
    /// @param syntaxTree The parent syntax tree.
    /// @param ifKeyword The `if` keyword token.
    /// @param condition The condition expression.
    /// @param thenBlock The then-block expression.
    /// @param elseKeyword The optional `else` keyword token (null when absent).
    /// @param elseExpression The optional else-branch: a (cref:BlockExpressionSyntax) or another
    /// (cref:IfExpressionSyntax) (null when absent).
    convenience init(
        syntaxTree SyntaxTree,
        ifKeyword SyntaxToken,
        condition ExpressionSyntax,
        thenBlock BlockExpressionSyntax,
        elseKeyword SyntaxToken?,
        elseExpression ExpressionSyntax?
    ) {
        init(syntaxTree, ifKeyword, nil, nil, condition, thenBlock, elseKeyword, elseExpression)
    }

    /// Initializes a new instance of the (cref:IfExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param ifKeyword The `if` keyword token.
    /// @param initializer The optional initializer simple statement (the `init` in `if init; cond`).
    /// @param semicolon The semicolon separating the initializer from the condition.
    /// @param condition The condition expression.
    /// @param thenBlock The then-block expression.
    /// @param elseKeyword The optional `else` keyword token (null when absent).
    /// @param elseExpression The optional else-branch: a (cref:BlockExpressionSyntax) or another
    /// (cref:IfExpressionSyntax) (null when absent).
    init(
        syntaxTree SyntaxTree,
        ifKeyword SyntaxToken,
        initializer StatementSyntax?,
        semicolon SyntaxToken?,
        condition ExpressionSyntax,
        thenBlock BlockExpressionSyntax,
        elseKeyword SyntaxToken?,
        elseExpression ExpressionSyntax?
    ) : base(syntaxTree) {
        IfKeyword = ifKeyword
        Initializer = initializer
        Semicolon = semicolon
        Condition = condition
        ThenBlock = thenBlock
        ElseKeyword = elseKeyword
        ElseExpression = elseExpression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IfExpression

    /// Gets the `if` keyword token.
    prop IfKeyword SyntaxToken {
        get;
    }

    /// Gets the optional initializer simple statement (the `init`
    /// in `if init; cond`). May be `null`.
    prop Initializer StatementSyntax? {
        get;
    }

    /// Gets the semicolon separating the initializer from the condition,
    /// or `null` when there is no initializer.
    prop Semicolon SyntaxToken? {
        get;
    }

    /// Gets the condition expression.
    prop Condition ExpressionSyntax {
        get;
    }

    /// Gets the then-block expression.
    prop ThenBlock BlockExpressionSyntax {
        get;
    }

    /// Gets the optional `else` keyword token.
    prop ElseKeyword SyntaxToken? {
        get;
    }

    /// Gets the else branch: a (cref:BlockExpressionSyntax) for a plain else,
    /// or another (cref:IfExpressionSyntax) for an `else if` chain.
    /// Null when no else branch is present.
    prop ElseExpression ExpressionSyntax? {
        get;
    }
}
