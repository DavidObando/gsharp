// <copyright file="BlockExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Issue #669: a block-with-trailing-expression of the form
/// `{ stmt1; stmt2; expr }`. The trailing expression (if present)
/// is the value produced by the block. When there is no trailing expression
/// the block is statement-only and is only legal in statement position.
partial class BlockExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:BlockExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBraceToken The opening `{` token.
    /// @param statements The prefix statements (all but the trailing? expression).
    /// @param expression The trailing expression that yields the block's value (may be null for
    /// statement-only blocks).
    /// @param closeBraceToken The closing `}` token.
    init(
        syntaxTree SyntaxTree,
        openBraceToken SyntaxToken,
        statements ImmutableArray[StatementSyntax],
        expression ExpressionSyntax?,
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        OpenBraceToken = openBraceToken
        Statements = statements
        Expression = expression
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.BlockExpression

    /// Gets the opening `{` token.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the prefix statements.
    prop Statements ImmutableArray[StatementSyntax] {
        get;
    }

    /// Gets the trailing expression. May be null for statement-only blocks
    /// (in which case the surrounding if-expression is only legal in statement
    /// position, which the binder enforces).
    prop Expression ExpressionSyntax? {
        get;
    }

    /// Gets the closing `}` token.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
