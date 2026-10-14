// <copyright file="MultiAssignmentStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a multi-target assignment statement, e.g.
/// `a, obj.Field, values[i] = b, 1, 2` or
/// `a, let fresh = Pair()`.
class MultiAssignmentStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:MultiAssignmentStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param targets The comma-separated assignment or fresh-local targets.
    /// @param operatorToken The operator token (`=` or `:=`).
    /// @param values The comma-separated right-hand side expressions.
    init(
        syntaxTree SyntaxTree,
        targets SeparatedSyntaxList[ExpressionSyntax],
        operatorToken SyntaxToken,
        values SeparatedSyntaxList[ExpressionSyntax]
    ) : base(syntaxTree) {
        Targets = targets
        OperatorToken = operatorToken
        Values = values
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.MultiAssignmentStatement

    /// Gets the comma-separated assignment or fresh-local targets.
    prop Targets SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the operator token (`=` for assignment, `:=` for short var declaration).
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the comma-separated right-hand side value expressions.
    prop Values SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }
}
