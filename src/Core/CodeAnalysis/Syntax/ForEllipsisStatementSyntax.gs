// <copyright file="ForEllipsisStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a for ellipsis statement syntax in the language. The
/// canonical separator is the contextual `in` token (e.g.
/// `for i in 0 ... 5`). The legacy `:=` spelling was removed by
/// ADR-0077 / issue #717; the parser still surfaces an (cref:InToken)
/// (synthesised when recovering from the legacy `:=` form) so
/// downstream binding and printing have a single, uniform shape.
partial class ForEllipsisStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ForEllipsisStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The for keyword.
    /// @param identifier The variable identifier.
    /// @param inToken The contextual `in` separator token.
    /// @param lowerBound The lower bound expression.
    /// @param ellipsisToken The ellipsis token.
    /// @param upperBound The upper bound expression.
    /// @param body The body statement.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        identifier SyntaxToken,
        inToken SyntaxToken,
        lowerBound ExpressionSyntax,
        ellipsisToken SyntaxToken,
        upperBound ExpressionSyntax,
        body StatementSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        Identifier = identifier
        InToken = inToken
        LowerBound = lowerBound
        EllipsisToken = ellipsisToken
        UpperBound = upperBound
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ForEllipsisStatement

    /// Gets the for keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the variable identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the contextual `in` separator token. May be a synthesised
    /// token when the parser recovered from the removed `:=` spelling.
    prop InToken SyntaxToken {
        get;
    }

    /// Gets the lower bound expression.
    prop LowerBound ExpressionSyntax {
        get;
    }

    /// Gets the ellipsis token.
    prop EllipsisToken SyntaxToken {
        get;
    }

    /// Gets the upper bound expression.
    prop UpperBound ExpressionSyntax {
        get;
    }

    /// Gets the body statement.
    prop Body StatementSyntax {
        get;
    }
}
