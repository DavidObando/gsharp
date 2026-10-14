// <copyright file="YieldStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `yield <expr>` statement in an iterator function
/// (ADR-0040), or the iteration-terminating `yield break` statement
/// (issue #3501: C#-aligned early exit from any nesting depth — `break`
/// keeps its loop binding).
class YieldStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:YieldStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param yieldKeyword The contextual `yield` keyword token.
    /// @param expression The expression to yield, or `null` for `yield break`.
    /// @param breakKeyword The `break` keyword token for `yield break`, or `null`.
    init(
        syntaxTree SyntaxTree,
        yieldKeyword SyntaxToken,
        expression ExpressionSyntax?,
        breakKeyword SyntaxToken? = nil
    ) : base(syntaxTree) {
        YieldKeyword = yieldKeyword
        Expression = expression
        BreakKeyword = breakKeyword
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.YieldStatement

    /// Gets the contextual `yield` keyword token.
    prop YieldKeyword SyntaxToken {
        get;
    }

    /// Gets the expression being yielded, or `null` for `yield break`.
    prop Expression ExpressionSyntax? {
        get;
    }

    /// Gets the `break` keyword for `yield break`, or `null`.
    prop BreakKeyword SyntaxToken? {
        get;
    }
}
