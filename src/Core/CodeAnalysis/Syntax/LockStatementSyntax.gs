// <copyright file="LockStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `lock expr { body }` statement (issue #1885). Mutual
/// exclusion follows the classic `System.Threading.Monitor.Enter` /
/// `try` / `finally` / `Monitor.Exit` pattern C# uses to
/// lower `lock (expr) { body }`.
partial class LockStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:LockStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param lockKeyword The `lock` keyword.
    /// @param expression The lock-target expression.
    /// @param body The body statement.
    init(syntaxTree SyntaxTree, lockKeyword SyntaxToken, expression ExpressionSyntax, body StatementSyntax) : base(
        syntaxTree
    ) {
        LockKeyword = lockKeyword
        Expression = expression
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.LockStatement

    /// Gets the `lock` keyword.
    prop LockKeyword SyntaxToken {
        get;
    }

    /// Gets the lock-target expression.
    prop Expression ExpressionSyntax {
        get;
    }

    /// Gets the body statement.
    prop Body StatementSyntax {
        get;
    }
}
