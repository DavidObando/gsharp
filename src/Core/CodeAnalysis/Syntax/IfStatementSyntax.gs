// <copyright file="IfStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an if statement in the language.
class IfStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:IfStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param ifKeyword The if keyword.
    /// @param condition The condition expression.
    /// @param thenStatement The then statement.
    /// @param elseClause The else clause.
    convenience init(
        syntaxTree SyntaxTree,
        ifKeyword SyntaxToken,
        condition ExpressionSyntax,
        thenStatement StatementSyntax,
        elseClause ElseClauseSyntax?
    ) {
        init(syntaxTree, ifKeyword, nil, nil, condition, thenStatement, elseClause)
    }

    /// Initializes a new instance of the (cref:IfStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param ifKeyword The if keyword.
    /// @param initializer The optional initializer simple statement (the `init` in `if init; cond`).
    /// @param semicolon The semicolon separating the initializer from the condition.
    /// @param condition The condition expression.
    /// @param thenStatement The then statement.
    /// @param elseClause The else clause.
    init(
        syntaxTree SyntaxTree,
        ifKeyword SyntaxToken,
        initializer StatementSyntax?,
        semicolon SyntaxToken?,
        condition ExpressionSyntax,
        thenStatement StatementSyntax,
        elseClause ElseClauseSyntax?
    ) : base(syntaxTree) {
        IfKeyword = ifKeyword
        Initializer = initializer
        Semicolon = semicolon
        Condition = condition
        ThenStatement = thenStatement
        ElseClause = elseClause
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IfStatement

    /// Gets the if keyword.
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

    /// Gets the then statement.
    prop ThenStatement StatementSyntax {
        get;
    }

    /// Gets the else clause.
    prop ElseClause ElseClauseSyntax? {
        get;
    }
}
