// <copyright file="IndexAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents an indexed assignment `target[index] = value`.
class IndexAssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:IndexAssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param targetIdentifier The identifier being indexed.
    /// @param openBracketToken The opening bracket token.
    /// @param index The index expression.
    /// @param closeBracketToken The closing bracket token.
    /// @param equalsToken The equals token.
    /// @param value The value expression.
    convenience init(
        syntaxTree SyntaxTree,
        targetIdentifier SyntaxToken,
        openBracketToken SyntaxToken,
        index ExpressionSyntax,
        closeBracketToken SyntaxToken,
        equalsToken SyntaxToken,
        value ExpressionSyntax
    ) {
        init(
            syntaxTree,
            targetIdentifier,
            openBracketToken,
            SeparatedSyntaxList[ExpressionSyntax](ImmutableArray.Create[SyntaxNode](index)),
            closeBracketToken,
            equalsToken,
            value
        )
    }

    /// Initializes a new instance of the (cref:IndexAssignmentExpressionSyntax) class.
    /// @param syntaxTree Parent syntax tree.
    /// @param targetIdentifier Target identifier.
    /// @param openBracketToken Opening bracket.
    /// @param indices Index expressions.
    /// @param closeBracketToken Closing bracket.
    /// @param equalsToken Equals token.
    /// @param value Assigned value.
    init(
        syntaxTree SyntaxTree,
        targetIdentifier SyntaxToken,
        openBracketToken SyntaxToken,
        indices SeparatedSyntaxList[ExpressionSyntax],
        closeBracketToken SyntaxToken,
        equalsToken SyntaxToken,
        value ExpressionSyntax
    ) : base(syntaxTree) {
        TargetIdentifier = targetIdentifier
        OpenBracketToken = openBracketToken
        Indices = indices
        CloseBracketToken = closeBracketToken
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IndexAssignmentExpression

    /// Gets the identifier being indexed.
    prop TargetIdentifier SyntaxToken {
        get;
    }

    /// Gets the opening bracket token.
    prop OpenBracketToken SyntaxToken {
        get;
    }

    /// Gets the index expression.
    @SyntaxChildIgnore
    prop Index ExpressionSyntax -> Indices[0]

    /// Gets index expressions.
    prop Indices SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the closing bracket token.
    prop CloseBracketToken SyntaxToken {
        get;
    }

    /// Gets the equals token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the value expression.
    prop Value ExpressionSyntax {
        get;
    }
}
