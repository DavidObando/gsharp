// <copyright file="MemberIndexAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an indexer assignment whose target is an arbitrary expression
/// rather than a bare identifier, e.g. `obj.Member[key] = value` or
/// `GetThing()[i] = v`. Issue #507: this complements
/// (cref:IndexAssignmentExpressionSyntax) (which is restricted to a
/// single identifier on the left of the brackets) by allowing the indexed
/// target to be any expression that produces an indexable value.
class MemberIndexAssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:MemberIndexAssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param target The parsed indexer access on the left of the equals sign.
    /// @param equalsToken The equals token.
    /// @param value The value expression on the right of the equals sign.
    init(syntaxTree SyntaxTree, target IndexExpressionSyntax, equalsToken SyntaxToken, value ExpressionSyntax) : base(
        syntaxTree
    ) {
        Target = target
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.MemberIndexAssignmentExpression

    /// Gets the indexer access expression on the left of the equals sign.
    prop Target IndexExpressionSyntax {
        get;
    }

    /// Gets the equals token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the value expression on the right of the equals sign.
    prop Value ExpressionSyntax {
        get;
    }
}
